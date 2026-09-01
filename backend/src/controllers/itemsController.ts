import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { validateItemInput } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { getItems, upsertItem, removeItem, getTrustSetting } from '../cache/appStore.js';

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
  const hours = (level: string): number => {
    const setting = getTrustSetting(level);
    return setting?.intervalo_recoleccion_horas_default ?? 24;
  };

  return {
    precio_familiar: round2(base * multiplier('familiares')),
    precio_amigo: round2(base * multiplier('amigos')),
    precio_conocido: round2(base * multiplier('conocidos')),
    precio_publico: round2(base * multiplier('publico')),
    horas_recoleccion_familiar: hours('familiares'),
    horas_recoleccion_amigo: hours('amigos'),
    horas_recoleccion_conocido: hours('conocidos'),
    horas_recoleccion_publico: hours('publico')
  };
}

export const createItem = async (req: Request, res: Response): Promise<void> => {
  const {
    title,
    description,
    category,
    infoUrl,
    imageUrl,
    visibility_level,
    event_id,
    available_from,
    visible_at,
    expires_at,
    precio_base_costo
  } = req.body;
  const adminSession = (req as any).adminSession; // Attached by requireAdminSession middleware

  // Validate input
  const validation = validateItemInput({ title, description, category, infoUrl, imageUrl });
  if (!validation.valid) {
    res.status(400).json({
      error: 'Validation failed',
      details: validation.errors,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Congelar el snapshot de precios por rol (multiplicadores del catálogo)
  const snapshot = computePriceSnapshot(precio_base_costo != null ? Number(precio_base_costo) : null);

  try {
    const insertQuery = `
      INSERT INTO items
        (title, description, category, info_url, image_url,
         visibility_level, event_id, available_from, visible_at, expires_at,
         precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
         horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido, horas_recoleccion_publico)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      RETURNING id, title, description, category, info_url, image_url, status,
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
      imageUrl,
      visibility_level ?? 4,
      event_id ?? null,
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
      imageUrl: item.image_url,
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
        imageUrl: item.image_url,
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
  const { title, description, infoUrl, visibility_level, event_id, available_from, visible_at, precio_base_costo } =
    req.body;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  if (
    !title &&
    description === undefined &&
    infoUrl === undefined &&
    visibility_level === undefined &&
    event_id === undefined &&
    available_from === undefined &&
    visible_at === undefined &&
    precio_base_costo === undefined
  ) {
    res.status(400).json({
      error: 'At least one editable field must be provided.'
    });
    return;
  }

  // Si cambia el precio base, re-congelar el snapshot
  const snapshot = computePriceSnapshot(precio_base_costo != null ? Number(precio_base_costo) : null);

  try {
    const updateQuery = `
      UPDATE items
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        info_url = COALESCE($3, info_url),
        visibility_level = COALESCE($4, visibility_level),
        event_id = COALESCE($5, event_id),
        available_from = COALESCE($6, available_from),
        visible_at = COALESCE($7, visible_at),
        precio_base_costo = COALESCE($8, precio_base_costo),
        precio_familiar = COALESCE($9, precio_familiar),
        precio_amigo = COALESCE($10, precio_amigo),
        precio_conocido = COALESCE($11, precio_conocido),
        precio_publico = COALESCE($12, precio_publico),
        horas_recoleccion_familiar = COALESCE($13, horas_recoleccion_familiar),
        horas_recoleccion_amigo = COALESCE($14, horas_recoleccion_amigo),
        horas_recoleccion_conocido = COALESCE($15, horas_recoleccion_conocido),
        horas_recoleccion_publico = COALESCE($16, horas_recoleccion_publico),
        updated_at = NOW()
      WHERE id = $17
      RETURNING id, title, description, category, info_url, image_url, status,
                visibility_level, event_id, available_from, visible_at, expires_at,
                precio_base_costo, precio_familiar, precio_amigo, precio_conocido, precio_publico,
                horas_recoleccion_familiar, horas_recoleccion_amigo, horas_recoleccion_conocido,
                horas_recoleccion_publico, nivel_acceso_minimo, created_at
    `;
    const result = await pool.query(updateQuery, [
      title || null,
      description !== undefined ? description : null,
      infoUrl !== undefined ? infoUrl : null,
      visibility_level !== undefined ? visibility_level : null,
      event_id !== undefined ? event_id : null,
      available_from !== undefined ? available_from : null,
      visible_at !== undefined ? visible_at : null,
      precio_base_costo !== undefined ? precio_base_costo : null,
      snapshot.precio_familiar,
      snapshot.precio_amigo,
      snapshot.precio_conocido,
      snapshot.precio_publico,
      snapshot.horas_recoleccion_familiar,
      snapshot.horas_recoleccion_amigo,
      snapshot.horas_recoleccion_conocido,
      snapshot.horas_recoleccion_publico,
      id
    ]);

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
      imageUrl: updatedItem.image_url,
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
        changedFields: { title: !!title, description: description !== undefined, infoUrl: infoUrl !== undefined }
      }
    });

    // Broadcast the update via SSE
    broadcastSseEvent('item_updated', {
      itemId: updatedItem.id,
      status: updatedItem.status,
      title: updatedItem.title,
      description: updatedItem.description,
      infoUrl: updatedItem.info_url
    });

    res.status(200).json({
      success: true,
      item: {
        id: updatedItem.id,
        title: updatedItem.title,
        description: updatedItem.description,
        category: updatedItem.category,
        infoUrl: updatedItem.info_url,
        imageUrl: updatedItem.image_url,
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

  try {
    // Delete the item row; related claims are removed automatically via ON DELETE CASCADE
    const result = await pool.query('DELETE FROM items WHERE id = $1 RETURNING id, title', [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }

    const deletedItem = result.rows[0];

    removeItem(deletedItem.id); // Write-through: quitar del store en RAM

    // Log audit entry
    await logAudit({
      action: 'ITEM_DELETED',
      adminCodeSuffix: maskAdminCode(String(adminSession?.id ?? '')),
      itemId: deletedItem.id,
      details: {
        title: deletedItem.title,
        timestamp: new Date().toISOString()
      }
    });

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
    console.error('Failed to delete item:', error);
    res.status(500).json({ error: 'Database execution error deleting item record.' });
  }
};
