import { Request, Response } from 'express';
import { handleUpload } from '@vercel/blob/client';

export const getUploadToken = async (req: Request, res: Response): Promise<void> => {
  /*
  const adminToken = req.headers['x-admin-token'];

  // Security guard: Ensure only you can request signed upload tokens
  if (adminToken !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized administrative access.' });
    return;
  }
  */

  try {



    // 🧠 El SDK de Vercel inyecta el payload del cliente dentro del cuerpo de la petición (req.body)
    const { clientPayload } = req.body;
    let payloadToken = '';

    if (clientPayload) {
      const parsedPayload = JSON.parse(clientPayload);
      payloadToken = parsedPayload.token;
    }

    // Security guard: Validamos el token extraído del payload seguro de Vercel
    if (payloadToken !== process.env.ADMIN_TOKEN) {
      res.status(401).json({ error: 'Unauthorized administrative access.' });
      return;
    }



    // handleUpload expects the raw request body payload from the client-side @vercel/blob SDK
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req as any, // Cast required to align Express request shape with Vercel internal interfaces
      onBeforeGenerateToken: async (pathname: string) => {
        // Enforce content-type security boundaries for your phone camera photos
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
          tokenPayload: JSON.stringify({ pathname }), // Optional custom client contextual tracking metadata
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // Runs asynchronously in the background once Vercel successfully finishes storing the file
        console.log(`Blob asset upload completed successfully: ${blob.url}`);
      },
    });

    res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Failed to handle Vercel Blob client token generation:', error);
    res.status(500).json({ error: 'Internal server error processing upload token handshakes.' });
  }
};
