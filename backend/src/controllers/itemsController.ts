import { Request, Response } from 'express';
import pool from '../config/db.js';
import type { PoolClient } from 'pg';
import type { ItemPhase } from '@claimitapp/shared';
import { broadcastSseEvent } from '../config/sse.js';
import { validateItemInput, validateImageUrls } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import {
  getItemById,
  upsertItem,
  removeItem,
  getEvent,
  getItemsByEventStatus,
  getEventStatusCounts,
  ensureHydrated,
  EVENT_STATUS_ORDER,
  type StoreItem
} from '../cache/appStore.js';
import { temporalStateFromStore } from '../services/queueService.js';
import { runLazyCatchUp } from '../services/scheduler.js';

/** Convierte una fila de `items` (RETURNING) a un StoreItem con la cola dada. */
function toStoreItem(item: any, queue: StoreItem['queue']): StoreItem {
  return {
    id: item.id,
    eventId: item.event_id ?? null,
    title: item.title,
    description: item.description,
    category: item.category,
    infoUrl: item.info_url,
    imageUrls: Array.isArray(item.image_urls) ? item.image_urls : [],
    status: item.status,
    phase: item.phase,
    visibilityLevel: item.visibility_level,
    precioBaseCosto: item.precio_base_costo,
    frozenSchedule: item.frozen_schedule ? item.frozen_schedule : null,
    frozenAt: item.frozen_at ?? null,
    freeWindowOpenedAt: item.free_window_opened_at ?? null,
    deliveredClaimId: item.delivered_claim_id ?? null,
    deliveredAt: item.delivered_at ?? null,
    charityAt: item.charity_at ?? null,
    createdAt: item.created_at,
    queue
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
    precio_base_costo
  } = req.body;
  const adminSession = (req as any).adminSession;

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

  try {
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
         visibility_level, event_id, precio_base_costo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, title, description, category, info_url, image_urls, status, phase,
                visibility_level, event_id,
                precio_base_costo, created_at
    `;
    const result = await pool.query(insertQuery, [
      title,
      description || null,
      category,
      infoUrl || null,
      JSON.stringify(imageUrls),
      visibility_level ?? 4,
      event_id,
      precio_base_costo ?? null
    ]);

    const item = result.rows[0];

    upsertItem(toStoreItem(item, []));

    await logAudit({
      action: 'ITEM_CREATED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: item.id,
      details: {
        title: item.title,
        category: item.category,
        phase: item.phase,
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
        phase: item.phase,
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
  const adminSession = (req as any).adminSession;
  const {
    title,
    description,
    infoUrl,
    imageUrls,
    visibility_level,
    event_id,
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

  if (imageUrls !== undefined) {
    const photoErrors: string[] = [];
    validateImageUrls(imageUrls, photoErrors);
    if (photoErrors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: photoErrors });
      return;
    }
  }

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
  if (imageUrls !== undefined) set('image_urls', JSON.stringify(imageUrls), 'imageUrls');
  if (visibility_level !== undefined) set('visibility_level', visibility_level, 'visibility_level');
  if (event_id !== undefined) {
    if (!event_id || typeof event_id !== 'string') {
      res.status(400).json({
        error: 'Invalid event_id: every item must belong to an event.',
        timestamp: new Date().toISOString()
      });
      return;
    }
    set('event_id', event_id, 'event_id');
  }
  if (precio_base_costo !== undefined) {
    set('precio_base_costo', precio_base_costo, 'precio_base_costo');
  }

  if (assignments.length === 0) {
    res.status(400).json({
      error: 'At least one editable field must be provided.'
    });
    return;
  }

  try {
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
      RETURNING id, title, description, category, info_url, image_urls, status, phase,
                visibility_level, event_id,
                precio_base_costo, created_at
    `;
    const result = await pool.query(updateQuery, params);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const updatedItem = result.rows[0];
    const existing = getItemById(updatedItem.id);

    upsertItem(toStoreItem(updatedItem, existing?.queue ?? []));

    await logAudit({
      action: 'ITEM_UPDATED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: updatedItem.id,
      details: {
        title: updatedItem.title,
        changedFields
      }
    });

    broadcastSseEvent('item_updated', {
      itemId: updatedItem.id,
      status: updatedItem.status,
      phase: updatedItem.phase,
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
        phase: updatedItem.phase,
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
  const adminSession = (req as any).adminSession;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const pre = await client.query('SELECT title FROM items WHERE id = $1', [id]);
    if (pre.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    const title: string = pre.rows[0].title;

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

    const result = await client.query('DELETE FROM items WHERE id = $1 RETURNING id, title', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const deletedItem = result.rows[0];
    await client.query('COMMIT');

    removeItem(deletedItem.id);
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
 * GET /api/items/:id/estado-temporal (v2 — contrato del plan §4.4)
 *
 * Responde el `ItemTemporalState` (estado_actual, tiempo restante del turno
 * activo, línea de tiempo fija congelada V1..V3/ventana/caridad y participantes).
 * Corre el lazy catch-up antes de responder para que el reloj esté al día
 * (freeze si T_inicio llegó, expirios/ventana/caridad por reloj).
 */
export const getItemTemporalState = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    await ensureHydrated();
    await runLazyCatchUp();

    const item = getItemById(id);
    if (!item) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const event = item.eventId ? getEvent(item.eventId) : undefined;
    res.status(200).json(temporalStateFromStore(item, event));
  } catch (error) {
    console.error('Failed to compute temporal state:', error);
    res.status(500).json({ error: 'Database processing error computing item temporal state.' });
  }
};

/**
 * GET /api/admin/items/:id — detalle admin (editor). Sirve desde RAM.
 */
export const getItemDetail = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  const item = getItemById(id);
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
    phase: item.phase,
    visibilityLevel: item.visibilityLevel,
    eventId: item.eventId,
    precioBaseCosto: item.precioBaseCosto,
    frozenSchedule: item.frozenSchedule,
    frozenAt: item.frozenAt,
    freeWindowOpenedAt: item.freeWindowOpenedAt,
    deliveredClaimId: item.deliveredClaimId,
    deliveredAt: item.deliveredAt,
    charityAt: item.charityAt,
    createdAt: item.createdAt,
    queue: item.queue
  });
};

/** Payload de claim admin (legacy shape simplificada + campos v2). */
function serializeQueueClaim(q: StoreItem['queue'][number]) {
  return {
    id: q.id,
    userUuid: q.userUuid,
    username: q.username,
    claimedAt: q.claimedAt,
    claimState: q.claimState,
    roleAtClaim: q.roleAtClaim,
    fifoPosition: q.fifoPosition,
    turnVExpiresAt: q.turnVExpiresAt
  };
}

/**
 * GET /api/admin/items?statuses=active,closing — listado admin filtrado por
 * estatus de evento. Fuente: índice por estatus en RAM. Incluye phase y la cola
 * forense v2.
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
        phase: item.phase as ItemPhase,
        visibilityLevel: item.visibilityLevel ?? 4,
        eventId: item.eventId ?? null,
        frozenSchedule: item.frozenSchedule,
        eventSummary: event
          ? {
              id: event.id,
              title: event.title ?? null,
              status: event.status ?? 'draft',
              published_at: event.published_at,
              available_from: event.available_from,
              claims_close_at: event.claims_close_at ?? null,
              pickup_deadline: event.pickup_deadline ?? null,
              pickup_schedule_info: event.pickup_schedule_info ?? null
            }
          : null,
        createdAt: item.createdAt,
        queue: item.queue.map(serializeQueueClaim)
      };
    });

    res.status(200).json({ items, counts: getEventStatusCounts() });
  } catch (error) {
    console.error('Failed to list admin items:', error);
    res.status(500).json({ error: 'Database processing error listing admin items.' });
  }
};
