import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';
import { validateItemInput } from '@claimitapp/shared';
import { logAudit, maskAdminCode } from '../utils/auditLog.js';
import { getItems, upsertItem, removeItem } from '../cache/appStore.js';

export const createItem = async (req: Request, res: Response): Promise<void> => {
  const { title, description, category, infoUrl, imageUrl } = req.body;
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

  try {
    const insertQuery = `
      INSERT INTO items (title, description, category, info_url, image_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, title, description, category, info_url, image_url, status, visibility_level, event_id, created_at
    `;
    const result = await pool.query(insertQuery, [
      title,
      description || null,
      category,
      infoUrl || null,
      imageUrl
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
  const { title, description, infoUrl } = req.body;

  if (!id) {
    res.status(400).json({ error: 'Missing item id parameter.' });
    return;
  }

  if (!title && description === undefined && infoUrl === undefined) {
    res.status(400).json({ error: 'At least one field (title, description, infoUrl) must be provided.' });
    return;
  }

  try {
    // Use COALESCE so undefined fields keep their existing DB values
    const updateQuery = `
      UPDATE items
      SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        info_url = COALESCE($3, info_url)
      WHERE id = $4
      RETURNING id, title, description, category, info_url, image_url, status, visibility_level, event_id, created_at
    `;
    const result = await pool.query(updateQuery, [
      title || null,
      description !== undefined ? description : null,
      infoUrl !== undefined ? infoUrl : null,
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
