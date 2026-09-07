import { Request, Response } from 'express';
import pool from '../config/db.js';
import type { PoolClient } from 'pg';
import { broadcastSseEvent } from '../config/sse.js';
import { validateItemInput, validateImageUrls } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import {
  getItems,
  upsertItem,
  removeItem,
  getTrustSetting,
  getEvent,
  getItemsByEventStatus,
  getEventStatusCounts,
  ensureHydrated,
  EVENT_STATUS_ORDER
} from '../cache/appStore.js';

const DEFAULT_MULTIPLIERS: Record<string, number> = {
  familiares: 0.7,
  amigos: 0.85,
  conocidos: 0.95,
  publico: 1.0
};

/** Redondear a 2 decimales */
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Calcula y "congela" el snapshot de 4 precios + horas de recolección por nivel
 * a partir de un único precio base y los multiplicadores del catálogo global.
 */
function computePriceSnapshot(
  base: number | null
): {
  precio_familiar: number | null;
  precio_amigo: number | null;
  precio_conocido: number | null;
  precio_publico: number | null;
  horas_recoleccion_familiar: number | null;
  horas_recoleccion_amigo: number | null;
  horas_recoleccion_conocido: number | null;
  horas_recoleccion_publico: number | null;
} {
  if (base == null) {
    return {
      precio_familiar: null,
      precio_amigo: null,
      precio_conocido: null,
      precio_publico: null,
      horas_recoleccion_familiar: null,
      horas_recoleccion_amigo: null,
      horas_recoleccion_conocido: null,
      horas_recoleccion_publico: null
    };
  }

  const multiplier = (level: string): number => {
    const setting = getTrustSetting(level);
    const m = setting?.multiplicador_precio_default;
    return m != null ? Number(m) : DEFAULT_MULTIPLIERS[level];
  };
  return {
    precio_familiar: round2(base * multiplier('familiares')),
    precio_amigo: round2(base * multiplier('amigos')),
    precio_conocido: round2(base * multiplier('conocidos')),
    precio_publico: round2(base * multiplier('publico')),
    // NOTE: horas_recoleccion_* per item are DEPRECATED as the authority for
    // the pickup window. The window is resolved per role from the EVENT
    // (events.<rol>_pickup_hours) with the trust matrix as fallback
    // (see queueService.resolvePickupWindow). Items no longer freeze a snapshot.
    horas_recoleccion_familiar: null,
    horas_recoleccion_amigo: null,
    horas_recoleccion_conocido: null,
    horas_recoleccion_publico: null
  };
}

export const createItem = async (req: Request, res: Response): Promise<void> => {
  const {
    title,
    description,
    category,
    infoUrl,
    imageUrls,
    visibility_level,
    event_id,
    available_from,
    visible_at,
    expires_at,
    precio_base_costo
  } = req.body;
  const adminSession = (req as any).adminSession; // Attached by requireAdminSession middleware

  // Validate input (imageUrls = arreglo ordenado de fotos, mínimo 1)
  const validation = validateItemInput({ title, description, category, infoUrl, imageUrls });
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Regla event-first: todo item debe pertenecer a un evento.
  if (!event_id || typeof event_id !== 'string') {
    res.status(400).json({
      error: 'event_id is required: every item must belong to an event.',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Congelar el snapshot de precios por rol (multiplicadores del catálogo)
  const snapshot = computePriceSnapshot(precio_base_costo != null ? Number(precio_base_costo) : null);

  try {
    // Verificar que el evento destino exista (400 amigable en vez de FK violation).
    const evCheck = await pool.query('SELECT id FROM events WHERE id = $1', [event_id]);
    if (evCheck.rows.length === 0) {
      res.status(400).json({
        error: 'Invalid event_id: the referenced event does not exist.',
        timestamp: new Date().toISOString()
      });
      return;
    }

    const insertQuery = `
      INSERT INTO items
        (title, description, category, info_url, image_urls,
         visibility_level, event_id, available_from, visible_at, expires_at,
         precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
         horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido, horas_recoleccion_publico)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING id, title, description, category, info_url, image_urls, status,
                visibility_level, event_id, available_from, visible_at, expires_at,
                precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
                horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido,
                horas_recoleccion_publico, nivel_acceso_minimo, created_at
    `;
    const result = await pool.query(insertQuery, [
      title,
      description || null,
      category,
      infoUrl || null,
      // JSONB: se envía serializado como JSON
      JSON.stringify(imageUrls),
      visibility_level ?? 4,
      event_id,
      available_from ?? null,
      visible_at ?? null,
      expires_at ?? null,
      precio_base_costo ?? null,
      snapshot.precio_familiar,
      snapshot.precio_amigo,
      snapshot.precio_conocido,
      snapshot.precio_publico,
      snapshot.horas_recoleccion_familiar,
      snapshot.horas_recoleccion_amigo,
      snapshot.horas_recoleccion_conocido,
      snapshot.horas_recoleccion_publico
    ]);

    const item = result.rows[0];

    // Write-through: actualizar el store en RAM
    upsertItem({
      id: item.id,
      title: item.title,
      description: item.description,
      category: item.category,
      infoUrl: item.info_url,
      imageUrls: item.image_urls ?? [],
      status: item.status,
      visibilityLevel: item.visibility_level,
      eventId: item.event_id,
      visibleAt: item.visible_at,
      availableFrom: item.available_from,
      expiresAt: item.expires_at,
      precioBaseCosto: item.precio_base_costo,
      precioFamiliar: item.precio_familiar,
      precioAmigo: item.precio_amigo,
      precioConocido: item.precio_conocido,
      precioPublico: item.precio_publico,
      horasRecoleccionFamiliar: item.horas_recoleccion_familiar,
      horasRecoleccionAmigo: item.horas_recoleccion_amigo,
      horasRecoleccionConocido: item.horas_recoleccion_conocido,
      horasRecoleccionPublico: item.horas_recoleccion_publico,
      nivelAccesoMinimo: item.nivel_acceso_minimo,
      createdAt: item.created_at,
      queue: []
    });

    // Log audit entry
    await logAudit({
      action: 'ITEM_CREATED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: item.id,
      details: {
        title: item.title,
        category: item.category,
        timestamp: new Date().toISOString()
      }
    });

    res.status(201).json({
      success: true,
      item: {
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.info_url,
        imageUrls: item.image_urls ?? [],
        status: item.status,
        createdAt: item.created_at
      }
    });
  } catch (error) {
    console.error('Failed to create item row:', error);
    res.status(500).json({
      error: 'Database insertion error creating new item',
      timestamp: new Date().toISOString()
    });
  }
};

export const updateItem = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const adminSession = (req as any).adminSession; // Attached by requireAdminSession middleware
  const {
    title,
    description,
    infoUrl,
    imageUrls,
    visibility_level,
    event_id,
    available_from,
    visible_at,
    precio_base_costo
  } = req.body;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  if (visibility_level !== undefined) {
    const level = Number(visibility_level);
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      res.status(400).json({ error: 'visibility_level must be an integer between 0 and 4.' });
      return;
    }
  }

  // imageUrls es un arreglo ordenado de fotos; se exige al menos 1 y URLs válidas
  if (imageUrls !== undefined) {
    const photoErrors: string[] = [];
    validateImageUrls(imageUrls, photoErrors);
    if (photoErrors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: photoErrors });
      return;
    }
  }

  // Construir el SET dinámicamente SOLO con las llaves presentes en el body.
  // Así se puede asignar NULL explícito para limpiar un campo opcional
  // (por ejemplo desasignar el evento o borrar available_from/visible_at),
  // algo imposible con el enfoque anterior basado en COALESCE.
  const assignments: string[] = [];
  const params: any[] = [];
  const changedFields: Record<string, boolean> = {};
  const set = (column: string, value: any, key: string): void => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
    changedFields[key] = true;
  };

  if (title !== undefined) set('title', title, 'title');
  if (description !== undefined) set('description', description, 'description');
  if (infoUrl !== undefined) set('info_url', infoUrl, 'infoUrl');
  // JSONB: el arreglo ordenado viaja como JSON serializado
  if (imageUrls !== undefined) set('image_urls', JSON.stringify(imageUrls), 'imageUrls');
  if (visibility_level !== undefined) set('visibility_level', visibility_level, 'visibility_level');
  if (event_id !== undefined) {
    // Regla event-first: el item no puede quedar sin evento.
    if (!event_id || typeof event_id !== 'string') {
      res.status(400).json({
        error: 'Invalid event_id: every item must belong to an event.',
        timestamp: new Date().toISOString()
      });
      return;
    }
    set('event_id', event_id, 'event_id');
  }
  if (available_from !== undefined) set('available_from', available_from, 'available_from');
  if (visible_at !== undefined) set('visible_at', visible_at, 'visible_at');
  if (precio_base_costo !== undefined) {
    // Si cambia el precio base, re-congelar el snapshot (null → sin precios)
    const snapshot = computePriceSnapshot(precio_base_costo != null ? Number(precio_base_costo) : null);
    set('precio_base_costo', precio_base_costo, 'precio_base_costo');
    set('precio_familiar', snapshot.precio_familiar, 'precio_familiar');
    set('precio_amigo', snapshot.precio_amigo, 'precio_amigo');
    set('precio_conocido', snapshot.precio_conocido, 'precio_conocido');
    set('precio_publico', snapshot.precio_publico, 'precio_publico');
  }

  if (assignments.length === 0) {
    res.status(400).json({
      error: 'At least one editable field must be provided.'
    });
    return;
  }

  try {
    // Regla event-first: si se asigna un evento, debe existir.
    if (event_id !== undefined) {
      const evCheck = await pool.query('SELECT id FROM events WHERE id = $1', [event_id]);
      if (evCheck.rows.length === 0) {
        res.status(400).json({
          error: 'Invalid event_id: the referenced event does not exist.',
          timestamp: new Date().toISOString()
        });
        return;
      }
    }
    params.push(id);
    const updateQuery = `
      UPDATE items
      SET ${assignments.join(', ')},
          updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING id, title, description, category, info_url, image_urls, status,
                visibility_level, event_id, available_from, visible_at, expires_at,
                precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
                horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido,
                horas_recoleccion_publico, nivel_acceso_minimo, created_at
    `;
    const result = await pool.query(updateQuery, params);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const updatedItem = result.rows[0];

    // Write-through: actualizar el store en RAM (preservando la cola actual)
    const existing = getItems().find(i => i.id === updatedItem.id);
    upsertItem({
      id: updatedItem.id,
      title: updatedItem.title,
      description: updatedItem.description,
      category: updatedItem.category,
      infoUrl: updatedItem.info_url,
      imageUrls: updatedItem.image_urls ?? [],
      status: updatedItem.status,
      visibilityLevel: updatedItem.visibility_level,
      eventId: updatedItem.event_id,
      visibleAt: updatedItem.visible_at,
      availableFrom: updatedItem.available_from,
      expiresAt: updatedItem.expires_at,
      precioBaseCosto: updatedItem.precio_base_costo,
      precioFamiliar: updatedItem.precio_familiar,
      precioAmigo: updatedItem.precio_amigo,
      precioConocido: updatedItem.precio_conocido,
      precioPublico: updatedItem.precio_publico,
      horasRecoleccionFamiliar: updatedItem.horas_recoleccion_familiar,
      horasRecoleccionAmigo: updatedItem.horas_recoleccion_amigo,
      horasRecoleccionConocido: updatedItem.horas_recoleccion_conocido,
      horasRecoleccionPublico: updatedItem.horas_recoleccion_publico,
      nivelAccesoMinimo: updatedItem.nivel_acceso_minimo,
      createdAt: updatedItem.created_at,
      queue: existing?.queue ?? []
    });

    // Log audit entry
    await logAudit({
      action: 'ITEM_UPDATED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: updatedItem.id,
      details: {
        title: updatedItem.title,
        changedFields
      }
    });

    // Broadcast the update via SSE (incluye el arreglo de fotos para que la
    // portada/galeía de otros clientes se actualice en vivo).
    broadcastSseEvent('item_updated', {
      itemId: updatedItem.id,
      status: updatedItem.status,
      title: updatedItem.title,
      description: updatedItem.description,
      infoUrl: updatedItem.info_url,
      imageUrls: updatedItem.image_urls ?? []
    });

    res.status(200).json({
      success: true,
      item: {
        id: updatedItem.id,
        title: updatedItem.title,
        description: updatedItem.description,
        category: updatedItem.category,
        infoUrl: updatedItem.info_url,
        imageUrls: updatedItem.image_urls ?? [],
        status: updatedItem.status,
        createdAt: updatedItem.created_at
      }
    });
  } catch (error) {
    console.error('Failed to update item:', error);
    res.status(500).json({ error: 'Database execution error updating item record.' });
  }
};

export const deleteItem = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const adminSession = (req as any).adminSession; // Attached by requireAdminSession middleware

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  let client: PoolClient | undefined;
  try {
    // Single transaction: the ITEM_DELETED audit row is inserted BEFORE the item is
    // removed (while the FK to items(id) still resolves) and the DELETE then runs in
    // the same transaction. This fixes the audit_log_item_id_fkey (23503) violation,
    // which fired because the audit insert referenced an item that had already been
    // deleted and autocommitted by the previous standalone DELETE.
    client = await pool.connect();
    await client.query('BEGIN');

    // Resolve the title inside the tx so the audit entry can record it, and confirm
    // the item exists before doing any further work.
    const pre = await client.query('SELECT title FROM items WHERE id = $1', [id]);
    if (pre.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    const title: string = pre.rows[0].title;

    // Audit BEFORE delete while the item is still present (FK satisfied). Wrapped in
    // a SAVEPOINT so a failed audit (logAudit returns false) only rolls back that one
    // statement and never blocks the deletion: the audit stays non-blocking by design.
    await client.query('SAVEPOINT audit_sp');
    const auditOk = await logAudit(
      {
        action: 'ITEM_DELETED',
        adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
        itemId: id,
        details: {
          title,
          timestamp: new Date().toISOString()
        }
      },
      client
    );
    if (auditOk) {
      await client.query('RELEASE SAVEPOINT audit_sp');
    } else {
      await client.query('ROLLBACK TO SAVEPOINT audit_sp');
    }

    // Delete the item row inside the same transaction. Related claims are removed via
    // ON DELETE CASCADE; ON DELETE SET NULL clears item_id on the just-written audit row.
    const result = await client.query('DELETE FROM items WHERE id = $1 RETURNING id, title', [id]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const deletedItem = result.rows[0];

    await client.query('COMMIT');

    removeItem(deletedItem.id); // Write-through: quitar del store en RAM

    // Broadcast the deletion via SSE
    broadcastSseEvent('item_deleted', {
      itemId: deletedItem.id,
      title: deletedItem.title
    });

    res.status(200).json({
      success: true,
      message: `Item "${deletedItem.title}" deleted successfully`
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {
        /* connection may already be released or the transaction aborted */
      });
    }
    console.error('Failed to delete item:', error);
    res.status(500).json({ error: 'Database execution error deleting item record.' });
  } finally {
    if (client) client.release();
  }
};

/**
 * GET /api/admin/items/:id
 * Devuelve el registro completo de un objeto (admin only) para poder precargar
 * el editor. Se sirve desde el store en RAM (misma fuente que GET /api/items),
 * sin consultar Neon.
 */
export const getItemDetail = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  const item = getItems().find(i => i.id === id);
  if (!item) {
    res.status(404).json({ error: 'Item not found.' });
    return;
  }

  res.status(200).json({
    id: item.id,
    title: item.title,
    description: item.description,
    category: item.category,
    infoUrl: item.infoUrl,
    imageUrls: item.imageUrls,
    status: item.status,
    visibilityLevel: item.visibilityLevel,
    eventId: item.eventId,
    visibleAt: item.visibleAt,
    availableFrom: item.availableFrom,
    expiresAt: item.expiresAt,
    precioBaseCosto: item.precioBaseCosto,
    precioFamiliar: item.precioFamiliar,
    precioAmigo: item.precioAmigo,
    precioConocido: item.precioConocido,
    precioPublico: item.precioPublico,
    createdAt: item.createdAt,
    queue: item.queue
  });
};

/**
 * GET /api/admin/items?statuses=active,closing
 *
 * Listado admin de objetos FILTRADO por estatus de evento (cambio 1 del plan):
 * - NO aplica el gatekeeping del feed público (publicación/visibilidad/lifecycle):
 *   un admin gestiona también objetos de eventos 'draft' o aún no publicados.
 * - Fuente: índice por estatus en RAM (appStore). Solo se sirven los buckets
 *   pedidos → payload acotado; el histórico 'closed' no se arrastra si el
 *   cliente no lo pide.
 * - `statuses` (obligatorio, ≥1, OR): lista separada por comas.
 * - Respuesta: { items, counts } donde `counts` da el total por cada estatus
 *   canónico (para pintar contadores de chips aun de estatus inactivos).
 */
export const listAllAdminItems = async (req: Request, res: Response): Promise<void> => {
  try {
    await ensureHydrated();

    const raw = String(req.query.statuses ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const requested = raw.filter((s) => (EVENT_STATUS_ORDER as readonly string[]).includes(s));
    if (requested.length === 0) {
      res.status(400).json({
        error: 'Query param "statuses" (comma-separated event statuses) is required with at least one valid value.'
      });
      return;
    }

    const rows = getItemsByEventStatus(requested, true);

    const items = rows.map((item) => {
      const event = item.eventId ? getEvent(item.eventId) : null;
      return {
        id: item.id,
        title: item.title,
        description: item.description,
        category: item.category,
        infoUrl: item.infoUrl,
        imageUrls: item.imageUrls,
        status: item.status,
        visibilityLevel: item.visibilityLevel ?? 4,
        eventId: item.eventId ?? null,
        visibleAt: item.visibleAt ?? null,
        availableFrom: item.availableFrom ?? null,
        eventSummary: event
          ? {
              id: event.id,
              title: event.title ?? null,
              status: event.status ?? 'draft',
              available_from: event.available_from,
              claims_close_at: event.claims_close_at ?? null,
              pickup_deadline: event.pickup_deadline ?? null,
              pickup_schedule_info: event.pickup_schedule_info ?? null
            }
          : null,
        createdAt: item.createdAt,
        queue: item.queue.map((q) => ({
          userUuid: q.userUuid,
          username: q.username,
          claimedAt: q.claimedAt,
          pickupDeadline: q.pickupDeadline ?? null,
          roleAtAssignment: q.roleAtAssignment ?? null
        }))
      };
    });

    res.status(200).json({ items, counts: getEventStatusCounts() });
  } catch (error) {
    console.error('Failed to list admin items:', error);
    res.status(500).json({ error: 'Database processing error listing admin items.' });
  }
};
