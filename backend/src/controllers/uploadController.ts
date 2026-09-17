import { Request, Response } from 'express';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { validateSessionToken } from '../utils/adminSession.js';

/**
 * Prefijo obligatorio de los pathnames de fotos: `event-AAAAMMDD/<archivo>`.
 * Mantiene el store ordenado por evento y hace útil el `--prefix` del GC.
 */
const PREFIJO_FOTOS = 'event-';

/**
 * Techo por archivo. El cliente optimiza la foto en el celular hasta ~200 KB
 * (con 1.5 MB como máximo del pipeline), así que 2 MB deja margen y frena abusos.
 */
const MAX_BYTES_FOTO = 2 * 1024 * 1024;

/**
 * Los pathnames son inmutables, así que se cachean un año en el edge y en el
 * navegador: menos transferencia y menos operaciones facturables.
 */
const CACHE_MAX_AGE_SEGUNDOS = 60 * 60 * 24 * 365;

/** Pathname fuera del prefijo permitido: se responde 400 (no 500). */
class RutaFotoInvalidaError extends Error {}

export const getUploadToken = async (req: Request, res: Response): Promise<void> => {
  try {
    // 🧠 El SDK de Vercel inyecta el payload del cliente dentro del cuerpo de la petición (req.body)
    const clientPayload: string | null = req.body?.payload?.clientPayload ?? null;
    let payloadToken = '';

    // Security guard: Validamos el token extraído del payload seguro de Vercel
    if (clientPayload) {
      try {
        payloadToken = JSON.parse(clientPayload)?.token ?? '';
      } catch {
        // Payload corrupto: se rechaza como no autorizado en lugar de reventar con 500.
        res.status(401).json({ error: 'Unauthorized administrative access.' });
        return;
      }
    }

    // El token viaja en el clientPayload del SDK de Vercel (no como header),
    // por lo que esta ruta valida la sesión de forma interna contra la BD.
    const session = await validateSessionToken(payloadToken);
    if (!session) {
      res.status(401).json({ error: 'Unauthorized administrative access.' });
      return;
    }

    // handleUpload expects the raw request body payload from the client-side @vercel/blob SDK
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req, // Cast required to align Express request shape with Vercel internal interfaces
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async (pathname: string) => {
        // Solo se emiten tokens para fotos del admin bajo el prefijo `event-.../`.
        if (!pathname.startsWith(PREFIJO_FOTOS)) {
          throw new RutaFotoInvalidaError(
            `Ruta no permitida: las fotos deben guardarse bajo "${PREFIJO_FOTOS}{AAAAMMDD}/".`
          );
        }

        // Enforce content-type security boundaries for your phone camera photos
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
          maximumSizeInBytes: MAX_BYTES_FOTO,
          addRandomSuffix: true, // evita colisiones y sobrescrituras de fotos
          cacheControlMaxAge: CACHE_MAX_AGE_SEGUNDOS,
          tokenPayload: JSON.stringify({ pathname }), // Optional custom client contextual tracking metadata
        };
      },
    });

    res.status(200).json(jsonResponse);
  } catch (error) {
    if (error instanceof RutaFotoInvalidaError) {
      res.status(400).json({ error: error.message });
      return;
    }

    console.error('Failed to handle Vercel Blob client token generation:', error);
    res.status(500).json({ error: 'Internal server error processing upload token handshakes.' });
  }
};
