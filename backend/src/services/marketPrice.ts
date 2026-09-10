/**
 * backend/src/services/marketPrice.ts
 *
 * Análisis de precio de mercado por código de barras (UPC/EAN/ISBN).
 *
 * Flujo (captura): la consulta a Gemini devuelve un `barcode`/`barcodeType`
 * (UPC/EAN/ISBN/ASIN). Este servicio llama a la API de precios (UPCitemdb,
 * endpoint trial por defecto) con el código numérico y calcula min/max/promedio
 * sobre las ofertas válidas de los últimos N meses.
 *
 * Diseño "adaptador intercambiable": la lectura de ofertas vive detrás de
 * `lookupPriceOffers(code)` para poder subir de plan o cambiar de proveedor
 * (p. ej. un agregador con soporte de ASIN) sin tocar la lógica de cálculo.
 *
 * Los valores son INFORMATIVOS (para presentar al admin en la captura y en el
 * card de item-detail): NO participan en el precio de venta por rol, que sigue
 * siendo base × multiplicador (items.precio_base_costo).
 *
 * Fallo siempre degrada a `null` (nunca rompe la captura del item).
 */
import type { BarcodeType } from '@claimitapp/shared';

/** Oferta mínima que consume el cálculo (proyección normalizada). */
export interface PriceOffer {
  price: number;
  currency: string | null;
  /** Timestamp Unix (segundos) de la última actualización de la oferta. */
  updated_t: number | null;
}

/** Resultado del análisis de mercado (camelCase, listo para el cliente). */
export interface MarketAnalysis {
  /** Código normalizado enviado a la API (dígitos de UPC/EAN). */
  code: string;
  /** Tipo normalizado (UPC/EAN/ISBN). ASIN NO se analiza. */
  type: Extract<BarcodeType, 'UPC' | 'EAN' | 'ISBN'>;
  /** Moneda de la fuente de ofertas (p. ej. USD) o null si no se pudo. */
  currency: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  averagePrice: number | null;
  /** Nº de ofertas válidas usadas para el cálculo (0 si no hay). */
  offersCount: number;
  /** Instante del análisis (ISO). */
  analyzedAt: string;
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/** URL base del lookup. Default = plan trial; se puede subir de plan por env. */
const UPCITEMDB_API_URL =
  process.env.UPCITEMDB_API_URL ?? 'https://api.upcitemdb.com/prod/trial/lookup';

/** Ventana temporal del análisis en meses (ofertas actualizadas en ese rango). */
const LOOKBACK_MONTHS = Number(process.env.MARKET_LOOKBACK_MONTHS ?? 6);

/** Redondear a 2 decimales. */
const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Normalización del código leído por Gemini
// ---------------------------------------------------------------------------

/**
 * Normaliza el código detectado por Gemini a una forma canónica.
 * - Dígitos puros (con espacios/guiones) de 8/12/13 dígitos → código numérico
 *   consultable (UPC/EAN/ISBN). El ISBN-13 (978/979) se consulta igual porque
 *   comparte el espacio EAN-13.
 * - Cualquier cosa no numérica (p. ej. ASIN) → `null` (UPCitemdb no la indexa).
 */
export function normalizeBarcode(
  rawCode: string | null | undefined
): string | null {
  if (!rawCode) return null;
  const digits = rawCode.replace(/[\s-]/g, '');
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(digits)) return null;
  return digits;
}

/** Tipo normalizado a partir del código numérico (ISBN-13 vs EAN/UPC). */
export function barcodeTypeOf(
  code: string
): Extract<BarcodeType, 'UPC' | 'EAN' | 'ISBN'> {
  if (code.length === 13 && /^(978|979)/.test(code)) return 'ISBN';
  if (code.length === 12) return 'UPC';
  return 'EAN';
}

// ---------------------------------------------------------------------------
// Adaptador de fuente de precios (intercambiable / actualizable de plan)
// ---------------------------------------------------------------------------

/**
 * Lee la lista de ofertas de la fuente para un código UPC/EAN/ISBN.
 * Devuelve `null` si la fuente no tiene datos (no encontrado / error de red).
 * El caller trata null como "sin análisis".
 *
 * Autenticación: el plan gratuito `/prod` de UPCitemdb NO requiere API key
 * (100 peticiones combinadas/día). La key es OPCIONAL (planes superiores) y
 * solo se envía en el header `key` cuando UPCITEMDB_API_KEY está configurada.
 */
async function upcitemdbLookup(code: string): Promise<PriceOffer[] | null> {
  const apiKey = process.env.UPCITEMDB_API_KEY;

  try {
    const url = `${UPCITEMDB_API_URL}?upc=${encodeURIComponent(code)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // User-Agent para identificarse ante la API.
      'User-Agent': 'claimitapp/1.0 (inventory price analysis)'
    };
    if (apiKey) headers.key = apiKey;

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      console.error(`[MARKETPRICE] UPCitemdb API error ${response.status} para ${code}`);
      return null;
    }

    const data: any = await response.json();
    if (!data || data.code !== 'OK' || !Array.isArray(data.items) || data.items.length === 0) {
      return null;
    }

    const item = data.items[0];
    const itemCurrency: string | null =
      typeof item?.currency === 'string' && item.currency ? item.currency : null;
    const offers: any[] = Array.isArray(item?.offers) ? item.offers : [];

    return offers
      .map((o: any): PriceOffer => {
        const price = o?.price != null ? Number(o.price) : Number.NaN;
        const currency =
          typeof o?.currency === 'string' && o.currency ? o.currency : itemCurrency;
        const updatedT = o?.updated_t != null ? Number(o.updated_t) : null;
        return { price, currency, updated_t: Number.isFinite(updatedT) ? updatedT : null };
      })
      .filter((o) => Number.isFinite(o.price) && o.price >= 0);
  } catch (error) {
    console.error(`[MARKETPRICE] Error consultando UPCitemdb para ${code}:`, error);
    return null;
  }
}

/**
 * Punto de entrada del adaptador. Si mañana se cambia a otro proveedor (con
 * soporte de ASIN o un plan superior de UPCitemdb), solo cambia esta función.
 */
async function lookupPriceOffers(code: string): Promise<PriceOffer[] | null> {
  return upcitemdbLookup(code);
}

// ---------------------------------------------------------------------------
// Cálculo de estadísticas (min / max / promedio)
// ---------------------------------------------------------------------------

/**
 * Calcula min/max/promedio sobre las ofertas actualizadas en los últimos
 * LOOKBACK_MONTHS meses. Si una oferta no reporta `updated_t` se considera
 * dentro de la ventana (no se descarta injustamente).
 *
 * La moneda es la de la mayoría de las ofertas válidas; las ofertas en otra
 * moneda se descartan del cálculo para no mezclar unidades.
 */
function computeStats(offers: PriceOffer[]): Omit<MarketAnalysis, 'code' | 'type' | 'analyzedAt'> | null {
  const cutoffMs = Date.now() - LOOKBACK_MONTHS * 30 * 24 * 60 * 60 * 1000;
  const cutoffUnix = Math.floor(cutoffMs / 1000);

  const withinWindow = offers.filter(
    (o) => o.updated_t == null || o.updated_t >= cutoffUnix
  );
  if (withinWindow.length === 0) return null;

  // Moneda predominante entre las ofertas válidas (fallback: primera disponible).
  const currencyCount = new Map<string, number>();
  for (const o of withinWindow) {
    if (o.currency) currencyCount.set(o.currency, (currencyCount.get(o.currency) ?? 0) + 1);
  }
  let dominantCurrency: string | null = null;
  let bestCount = 0;
  for (const [cur, count] of currencyCount) {
    if (count > bestCount) {
      dominantCurrency = cur;
      bestCount = count;
    }
  }
  if (!dominantCurrency && withinWindow[0]?.currency) {
    dominantCurrency = withinWindow[0].currency;
  }

  const priced = dominantCurrency
    ? withinWindow.filter((o) => o.currency === dominantCurrency)
    : withinWindow;
  if (priced.length === 0) return null;

  const values = priced.map((o) => o.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, p) => sum + p, 0) / values.length;

  return {
    currency: dominantCurrency,
    minPrice: round2(min),
    maxPrice: round2(max),
    averagePrice: round2(avg),
    offersCount: priced.length
  };
}

// ---------------------------------------------------------------------------
// API pública del servicio
// ---------------------------------------------------------------------------

/**
 * Analiza el precio de mercado de un código detectado por Gemini.
 * Devuelve `null` (sin romper el flujo) si:
 *  - el código no es UPC/EAN/ISBN consultable, o
 *  - la fuente no tiene datos / falla / no hay API key, o
 *  - no hay ofertas válidas dentro de la ventana.
 */
export async function analyzeBarcodeMarket(
  rawCode: string | null | undefined
): Promise<MarketAnalysis | null> {
  const code = normalizeBarcode(rawCode);
  if (!code) return null;

  const offers = await lookupPriceOffers(code);
  if (!offers) return null;

  const stats = computeStats(offers);
  if (!stats) return null;

  return {
    code,
    type: barcodeTypeOf(code),
    analyzedAt: new Date().toISOString(),
    ...stats
  };
}
