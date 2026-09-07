/**
 * backend/src/utils/pricing.ts
 *
 * Resolución del precio visible POR ROL a partir del precio base del item y de
 * los multiplicadores del catálogo (trust_levels_settings), calculado EN TIEMPO
 * DE LECTURA. Ya no se congela un snapshot de 4 precios en items (ver migración
 * 015): items guarda únicamente `precio_base_costo`.
 */
import { getTrustSetting } from '../cache/appStore.js';

/** Multiplicadores por defecto por nivel (fallback si no hay configuración). */
export const DEFAULT_MULTIPLIERS: Record<string, number> = {
  familiares: 0.7,
  amigos: 0.85,
  conocidos: 0.95,
  publico: 1.0
};

/** Redondear a 2 decimales. */
export const round2 = (v: number): number => Math.round(v * 100) / 100;

/** Multiplicador de precio para un rol (matriz de confianza o default). */
export function priceMultiplier(role: string): number {
  const setting = getTrustSetting(role);
  const m = setting?.multiplicador_precio_default;
  return m != null ? Number(m) : DEFAULT_MULTIPLIERS[role];
}

/** Precio visible por rol: base × multiplicador (redondeado); null si no hay base. */
export function rolePrice(base: number | null, role: string): number | null {
  if (base == null) return null;
  return round2(base * priceMultiplier(role));
}
