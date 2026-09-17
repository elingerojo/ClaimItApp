/**
 * Web Worker de optimización de fotos (la compresión ocurre **en el celular**,
 * antes de pedir el token firmado y subir a Vercel Blob).
 *
 * Pipeline: `createImageBitmap` (aplica la orientación EXIF antes de escalar) →
 * `OffscreenCanvas` → `convertToBlob` con búsqueda decreciente de calidad hasta
 * el peso objetivo. El re-encode por canvas descarta además EXIF/GPS.
 *
 * El worker no decide nada de negocio: devuelve bytes, tipo y dimensiones, y el
 * módulo `image-compress.ts` resuelve los fallbacks (JPEG, hilo principal o
 * subir el archivo original).
 */

import {
  ajustarDimensiones,
  codificarHastaObjetivo,
  type IntentoCodificado
} from './image-compress.core';

export interface CompressRequest {
  id: number;
  file: File;
  /** Lado mayor permitido (p. ej. 1280). */
  maxDimension: number;
  /** Escalón de dimensión si ni con la calidad mínima cabe en `maxBytes`. */
  minDimension: number;
  /** Peso objetivo en bytes (p. ej. 200 KB). */
  targetBytes: number;
  /** Techo duro en bytes por encima del cual se aplica el escalón de dimensión. */
  maxBytes: number;
  qualityStart: number;
  qualityMin: number;
}

export interface CompressResponse {
  id: number;
  ok: boolean;
  error?: string;
  /** Bytes de la imagen codificada (se transfiere sin copia). */
  buffer?: ArrayBuffer;
  mimeType?: string;
  width?: number;
  height?: number;
  quality?: number;
  bytes?: number;
}

/**
 * Shim mínimo del scope del worker. Se prefiere esto antes que
 * `/// <reference lib="webworker" />` porque el programa ya carga la lib DOM y
 * mezclar ambas produce conflictos de tipos en `self`.
 */
const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CompressRequest>) => void) | null;
  postMessage: (message: CompressResponse, transfer?: Transferable[]) => void;
};

const PASOS_CALIDAD = 6;
const FACTOR_CALIDAD = 0.88;

let tipoSalidaCacheado: string | null = null;

/** WebP si el motor puede codificarlo; JPEG como respaldo. */
async function tipoSalidaSoportado(): Promise<string> {
  if (tipoSalidaCacheado) return tipoSalidaCacheado;

  try {
    const sonda = new OffscreenCanvas(1, 1);
    const blob = await sonda.convertToBlob({ type: 'image/webp' });
    tipoSalidaCacheado = blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
  } catch {
    tipoSalidaCacheado = 'image/jpeg';
  }

  return tipoSalidaCacheado;
}

/** Decodifica aplicando la orientación EXIF cuando el motor lo soporta. */
async function decodificar(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Opciones no soportadas por este motor: se decodifica sin orientación.
  }
  return await createImageBitmap(file);
}

/** Dibuja el bitmap en un OffscreenCanvas del tamaño pedido y busca la calidad. */
async function renderizarYBuscar(
  bitmap: ImageBitmap,
  dim: { width: number; height: number },
  tipo: string,
  req: CompressRequest
): Promise<IntentoCodificado> {
  const lienzo = new OffscreenCanvas(dim.width, dim.height);
  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D no disponible.');

  // JPEG no tiene alfa: si el origen era PNG con transparencia, se aplana a blanco.
  if (tipo === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim.width, dim.height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, dim.width, dim.height);

  return codificarHastaObjetivo(
    (quality) => lienzo.convertToBlob({ type: tipo, quality }),
    dim,
    {
      targetBytes: req.targetBytes,
      qualityStart: req.qualityStart,
      qualityMin: req.qualityMin,
      pasos: PASOS_CALIDAD,
      factor: FACTOR_CALIDAD
    }
  );
}

async function comprimir(req: CompressRequest): Promise<CompressResponse> {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { id: req.id, ok: false, error: 'offscreen-canvas-unavailable' };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodificar(req.file);
    const tipo = await tipoSalidaSoportado();

    let intento = await renderizarYBuscar(
      bitmap,
      ajustarDimensiones(bitmap.width, bitmap.height, req.maxDimension),
      tipo,
      req
    );

    // Escalón de dimensión: si ni con la calidad mínima cabe en el techo duro,
    // se reduce una sola vez a minDimension y se reintenta.
    if (intento.blob.size > req.maxBytes) {
      const dim = ajustarDimensiones(bitmap.width, bitmap.height, req.minDimension);
      if (dim.width !== intento.width || dim.height !== intento.height) {
        const segundo = await renderizarYBuscar(bitmap, dim, tipo, req);
        if (segundo.blob.size < intento.blob.size) intento = segundo;
      }
    }

    const buffer = await intento.blob.arrayBuffer();
    return {
      id: req.id,
      ok: true,
      buffer,
      mimeType: intento.blob.type || tipo,
      width: intento.width,
      height: intento.height,
      quality: intento.quality,
      bytes: buffer.byteLength
    };
  } catch (error) {
    return {
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    bitmap?.close();
  }
}

workerScope.onmessage = (event: MessageEvent<CompressRequest>): void => {
  const req = event.data;
  void comprimir(req).then((res) =>
    workerScope.postMessage(res, res.buffer ? [res.buffer] : undefined)
  );
};
