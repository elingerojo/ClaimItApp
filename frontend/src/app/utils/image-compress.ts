/**
 * Optimización de fotos en el celular antes de subirlas a Vercel Blob.
 *
 * Objetivo: que cada foto llegue al store como WebP de lado mayor 1280 px y
 * ~200 KB, en lugar de los ~1.9 MB de las fotos crudas de la cámara.
 *
 * Tres caminos, siempre hacia adelante (nunca bloquea la captura):
 *   1. Web Worker + OffscreenCanvas  (el normal en móviles modernos).
 *   2. Canvas del documento en el hilo principal (motores sin OffscreenCanvas en worker).
 *   3. Archivo original tal cual (sin decoder/encoder útil, o si el resultado pesa más).
 */

import { ajustarDimensiones, codificarHastaObjetivo, type IntentoCodificado } from './image-compress.core';
import type { CompressRequest, CompressResponse } from './image-compress.worker';

/** Lado mayor de la foto optimizada. */
export const FOTO_MAX_DIMENSION = 1280;
/** Escalón de dimensión si ni con la calidad mínima se alcanza el objetivo. */
export const FOTO_MIN_DIMENSION = 1024;
/** Peso objetivo por foto (~200 KB). */
export const FOTO_TARGET_BYTES = 200 * 1024;
/** Techo duro del pipeline: por encima de esto se aplica el escalón de dimensión. */
export const FOTO_HARD_MAX_BYTES = Math.round(1.5 * 1024 * 1024);
/** Calidad inicial (la más alta que se intenta). */
export const FOTO_QUALITY_START = 0.86;
/** Piso de calidad: nunca se baja de aquí. */
export const FOTO_QUALITY_MIN = 0.52;
/** Tiempo máximo que se espera al worker antes de caer al hilo principal. */
export const FOTO_WORKER_TIMEOUT_MS = 15000;

const PASOS_CALIDAD = 6;
const FACTOR_CALIDAD = 0.88;

export interface OpcionesFoto {
  maxDimension: number;
  minDimension: number;
  targetBytes: number;
  maxBytes: number;
  qualityStart: number;
  qualityMin: number;
}

export interface FotoComprimida {
  /** Archivo listo para subir (ya optimizado o el original si hubo fallback). */
  file: File;
  bytes: number;
  originalBytes: number;
  width: number | null;
  height: number | null;
  mimeType: string;
  /** Camino que produjo el resultado. */
  strategy: 'worker' | 'main-thread' | 'original';
  /** true cuando la foto ya cumplía el objetivo y no se volvió a codificar. */
  skipped: boolean;
  /** Motivo del fallback (solo diagnóstico). */
  error?: string;
}

const OPCIONES_POR_DEFECTO: OpcionesFoto = {
  maxDimension: FOTO_MAX_DIMENSION,
  minDimension: FOTO_MIN_DIMENSION,
  targetBytes: FOTO_TARGET_BYTES,
  maxBytes: FOTO_HARD_MAX_BYTES,
  qualityStart: FOTO_QUALITY_START,
  qualityMin: FOTO_QUALITY_MIN
};

let secuenciaWorker = 0;
let tipoSalidaCacheado: string | null = null;

function esImagen(file: File): boolean {
  return typeof file.type === 'string' && file.type.startsWith('image/');
}

function mensajeDeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extensión coherente con el tipo real del archivo optimizado. */
export function extensionParaMime(mimeType: string): string {
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  return 'bin';
}

/** Nombre descriptivo (solo diagnóstico: el pathname lo arma admin-ingest). */
export function nombreFotoOptimizada(nombreOriginal: string, mimeType: string): string {
  const base = (nombreOriginal || 'foto')
    .replace(/\.[^./\\]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${base || 'foto'}.${extensionParaMime(mimeType)}`;
}

function resultadoOriginal(file: File, opts: { skipped: boolean; error?: string }): FotoComprimida {
  return {
    file,
    bytes: file.size,
    originalBytes: file.size,
    width: null,
    height: null,
    mimeType: file.type || 'application/octet-stream',
    strategy: 'original',
    skipped: opts.skipped,
    error: opts.error
  };
}

// ---------------------------------------------------------------------------
// Camino 1: Web Worker + OffscreenCanvas
// ---------------------------------------------------------------------------

function soportaWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  );
}

function comprimirEnWorker(
  file: File,
  opts: OpcionesFoto
): Promise<{ blob: Blob; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    // El builder (@angular/build:application, esbuild) emite el worker como chunk.
    const worker = new Worker(new URL('./image-compress.worker', import.meta.url), {
      type: 'module'
    });
    const id = ++secuenciaWorker;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const terminar = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      worker.terminate();
    };

    timer = setTimeout(() => {
      terminar();
      reject(new Error('El worker de compresión excedió el tiempo de espera.'));
    }, FOTO_WORKER_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<CompressResponse>): void => {
      const res = event.data;
      if (!res || res.id !== id) return;

      terminar();
      if (!res.ok || !res.buffer) {
        reject(new Error(res.error || 'El worker no pudo comprimir la foto.'));
        return;
      }

      resolve({
        blob: new Blob([res.buffer], { type: res.mimeType || 'image/webp' }),
        width: res.width ?? 0,
        height: res.height ?? 0
      });
    };

    worker.onerror = (event: ErrorEvent): void => {
      terminar();
      reject(new Error(event.message || 'El worker de compresión falló.'));
    };

    const req: CompressRequest = { id, file, ...opts };
    worker.postMessage(req);
  });
}

// ---------------------------------------------------------------------------
// Camino 2: canvas del documento en el hilo principal
// ---------------------------------------------------------------------------

function tipoSalidaSoportadoEnHilo(): string {
  if (tipoSalidaCacheado) return tipoSalidaCacheado;

  try {
    const lienzo = document.createElement('canvas');
    lienzo.width = 1;
    lienzo.height = 1;
    tipoSalidaCacheado = lienzo.toDataURL('image/webp').startsWith('data:image/webp')
      ? 'image/webp'
      : 'image/jpeg';
  } catch {
    tipoSalidaCacheado = 'image/jpeg';
  }

  return tipoSalidaCacheado;
}

function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('El navegador no pudo decodificar la imagen.'));
    img.src = url;
  });
}

interface FuenteDecodificada {
  fuente: CanvasImageSource;
  width: number;
  height: number;
  liberar: () => void;
}

async function decodificarEnHilo(file: File): Promise<FuenteDecodificada> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        fuente: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        liberar: () => bitmap.close()
      };
    } catch {
      // Motor sin soporte de opciones: se intenta con <img>.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await cargarImagen(url);
    return {
      fuente: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      liberar: () => URL.revokeObjectURL(url)
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function codificarConCanvas(
  lienzo: HTMLCanvasElement,
  type: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    lienzo.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('El navegador no pudo codificar la imagen.'));
      },
      type,
      quality
    );
  });
}

function renderizarYBuscarEnHilo(
  fuente: CanvasImageSource,
  dim: { width: number; height: number },
  tipo: string,
  opts: OpcionesFoto
): Promise<IntentoCodificado> {
  const lienzo = document.createElement('canvas');
  lienzo.width = dim.width;
  lienzo.height = dim.height;

  const ctx = lienzo.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D no disponible.');

  if (tipo === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim.width, dim.height);
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(fuente, 0, 0, dim.width, dim.height);

  return codificarHastaObjetivo((quality) => codificarConCanvas(lienzo, tipo, quality), dim, {
    targetBytes: opts.targetBytes,
    qualityStart: opts.qualityStart,
    qualityMin: opts.qualityMin,
    pasos: PASOS_CALIDAD,
    factor: FACTOR_CALIDAD
  });
}

async function comprimirEnHiloPrincipal(
  file: File,
  opts: OpcionesFoto
): Promise<{ blob: Blob; width: number; height: number }> {
  const decodificada = await decodificarEnHilo(file);
  try {
    const tipo = tipoSalidaSoportadoEnHilo();

    let intento = await renderizarYBuscarEnHilo(
      decodificada.fuente,
      ajustarDimensiones(decodificada.width, decodificada.height, opts.maxDimension),
      tipo,
      opts
    );

    if (intento.blob.size > opts.maxBytes) {
      const dim = ajustarDimensiones(decodificada.width, decodificada.height, opts.minDimension);
      if (dim.width !== intento.width || dim.height !== intento.height) {
        const segundo = await renderizarYBuscarEnHilo(decodificada.fuente, dim, tipo, opts);
        if (segundo.blob.size < intento.blob.size) intento = segundo;
      }
    }

    return { blob: intento.blob, width: intento.width, height: intento.height };
  } finally {
    decodificada.liberar();
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Comprime una foto en el dispositivo. **Nunca lanza**: ante cualquier problema
 * devuelve el archivo original para que la captura no se bloquee.
 */
export async function comprimirFoto(
  file: File,
  opts: Partial<OpcionesFoto> = {}
): Promise<FotoComprimida> {
  const opciones: OpcionesFoto = { ...OPCIONES_POR_DEFECTO, ...opts };

  if (!esImagen(file)) return resultadoOriginal(file, { skipped: false });

  // Atajo: la foto ya cumple el objetivo (evita pérdida generacional y CPU).
  if (file.size <= opciones.targetBytes) {
    return resultadoOriginal(file, { skipped: true });
  }

  let intento: { blob: Blob; width: number; height: number } | null = null;
  let strategy: 'worker' | 'main-thread' = 'worker';
  let error: string | undefined;

  if (soportaWorker()) {
    try {
      intento = await comprimirEnWorker(file, opciones);
    } catch (err) {
      error = mensajeDeError(err);
      intento = null;
    }
  } else {
    error = 'offscreen-canvas-unavailable';
  }

  if (!intento) {
    strategy = 'main-thread';
    try {
      intento = await comprimirEnHiloPrincipal(file, opciones);
    } catch (err) {
      error = mensajeDeError(err);
      intento = null;
    }
  }

  // Si el re-encode no mejora al original, se sube el original tal cual.
  if (!intento || intento.blob.size >= file.size) {
    return resultadoOriginal(file, { skipped: false, error });
  }

  const mimeType = intento.blob.type || 'image/webp';
  const optimizada = new File([intento.blob], nombreFotoOptimizada(file.name, mimeType), {
    type: mimeType,
    lastModified: Date.now()
  });

  return {
    file: optimizada,
    bytes: optimizada.size,
    originalBytes: file.size,
    width: intento.width || null,
    height: intento.height || null,
    mimeType,
    strategy,
    skipped: false,
    error
  };
}
