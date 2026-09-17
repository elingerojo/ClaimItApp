/**
 * Helpers puros del pipeline de compresión de fotos.
 *
 * Viven en su propio módulo (y no dentro del worker) porque los comparten los dos
 * caminos de ejecución: el Web Worker (OffscreenCanvas) y el fallback en el hilo
 * principal (canvas del documento). Es deliberadamente libre de APIs de ventana
 * para poder importarse desde ambos contextos.
 */

export interface Dimensiones {
  width: number;
  height: number;
}

/**
 * Escala proporcionalmente para que el lado mayor no supere `max`.
 * Nunca agranda: si la imagen ya cabe, devuelve sus dimensiones originales.
 */
export function ajustarDimensiones(width: number, height: number, max: number): Dimensiones {
  const ancho = Math.max(1, Math.round(width));
  const alto = Math.max(1, Math.round(height));
  const mayor = Math.max(ancho, alto);
  if (mayor <= max) return { width: ancho, height: alto };

  const factor = max / mayor;
  return {
    width: Math.max(1, Math.round(ancho * factor)),
    height: Math.max(1, Math.round(alto * factor))
  };
}

export interface IntentoCodificado {
  blob: Blob;
  width: number;
  height: number;
  /** Calidad con la que se generó este intento. */
  quality: number;
}

export interface OpcionesBusqueda {
  /** Peso objetivo en bytes. */
  targetBytes: number;
  /** Calidad inicial: la más alta que se intenta primero. */
  qualityStart: number;
  /** Piso de calidad: nunca se baja de aquí. */
  qualityMin: number;
  /** Número máximo de intentos (default 6). */
  pasos?: number;
  /** Factor multiplicativo aplicado a la calidad en cada intento (default 0.88). */
  factor?: number;
}

/**
 * Codifica bajando la calidad de forma decreciente hasta cumplir `targetBytes`.
 *
 * Devuelve el **primer** intento que cumple (es decir, la mejor calidad posible
 * dentro del objetivo) o, si ninguno lo cumple, el más liviano de los intentos
 * para que el llamador decida (escalón de dimensión o conservar el original).
 */
export async function codificarHastaObjetivo(
  codificar: (quality: number) => Promise<Blob>,
  dim: Dimensiones,
  opts: OpcionesBusqueda
): Promise<IntentoCodificado> {
  const pasos = opts.pasos ?? 6;
  const factor = opts.factor ?? 0.88;

  let quality = opts.qualityStart;
  let masLiviano: IntentoCodificado | null = null;

  for (let i = 0; i < pasos; i++) {
    const blob = await codificar(quality);
    const intento: IntentoCodificado = { blob, width: dim.width, height: dim.height, quality };

    if (blob.size <= opts.targetBytes) return intento;
    if (!masLiviano || blob.size < masLiviano.blob.size) masLiviano = intento;

    const siguiente = Math.max(opts.qualityMin, quality * factor);
    if (siguiente >= quality) break; // ya estamos en el piso de calidad
    quality = siguiente;
  }

  if (!masLiviano) throw new Error('No se pudo codificar la imagen.');
  return masLiviano;
}
