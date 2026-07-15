import { Request, Response } from 'express';
import pool from '../config/db.js';
import { broadcastSseEvent } from '../config/sse.js';

export const createItem = async (req: Request, res: Response): Promise<void> => {
  const adminToken = req.headers['x-admin-token'];
  const { title, description, category, infoUrl, imageUrl } = req.body;

  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }

  if (!title || !category || !imageUrl) {
    res.status(400).json({ error: 'Missing required item tracking parameters.' });
    return;
  }

  try {
    const insertQuery = `
      INSERT INTO items (title, description, category, info_url, image_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, title, description, category, info_url, image_url, status, created_at
    `;
    const result = await pool.query(insertQuery, [
      title,
      description || null,
      category,
      infoUrl || null,
      imageUrl
    ]);

    res.status(201).json({
      success: true,
      item: {
        id: result.rows[0].id,
        title: result.rows[0].title,
        description: result.rows[0].description,
        category: result.rows[0].category,
        infoUrl: result.rows[0].info_url,
        imageUrl: result.rows[0].image_url,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at
      }
    });
  } catch (error) {
    console.error('Failed to create item row:', error);
    res.status(500).json({ error: 'Database insertion error creating new asset item.' });
  }
};

export const updateItem = async (req: Request, res: Response): Promise<void> => {
  const adminToken = req.headers['x-admin-token'];

  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }

  const { id } = req.params;
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
      RETURNING id, title, description, category, info_url, image_url, status, created_at
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

    // Broadcast the update via SSE so all browsers reflect changes in real time
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
