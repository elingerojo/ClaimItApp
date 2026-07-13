import { Request, Response } from 'express';
import pool from '../config/db.js';

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
      RETURNING id, status, created_at
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
      item: result.rows[0]
    });
  } catch (error) {
    console.error('Failed to create item row:', error);
    res.status(500).json({ error: 'Database insertion error creating new asset item.' });
  }
};
