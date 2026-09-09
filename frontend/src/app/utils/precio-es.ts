/**
 * Utilidades para renderizar precios en es-MX con separador de miles.
 *
 * Motivación:
 * - El backend entrega `precioVisible` como número limpio redondeado a 2
 *   decimales (p. ej. 100, 850, 1500.5), pero el frontend lo mostraba "crudo",
 *   sin agrupar: `1500.5` se ve ambiguo cuando supera los miles.
 * - Angular NO formatea por defecto: los pipes nativos exigirían
 *   `registerLocaleData('es-MX')` + config de bundling, así que se sigue la
 *   convención interna de util + pipe propio con `Intl` es-MX
 *   (ver date-es.ts / date-es.pipe.ts).
 *
 * Formato objetivo (decisión del usuario):
 * - Pesos enteros: 0 decimales SIEMPRE, TRUNCANDO la parte fraccionaria
 *   (Math.trunc, sin redondear) y sin `.00` de relleno.
 * - Separador de miles = coma (lo da `Intl.NumberFormat('es-MX', ...)` con
 *   grouping). El símbolo `$` lo conserva el template (este formato NO agrega
 *   moneda).
 *
 * Ejemplos:
 *   100       -> "100"
 *   850       -> "850"
 *   1500.5    -> "1,500"  (trunca .5, NO redondea a "1,501")
 *   1234567.89 -> "1,234,567"
 *   null/undefined/NaN -> ""
 */
export function formatPrecioEs(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '';
  const truncado = Math.trunc(value);
  return new Intl.NumberFormat('es-MX', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(truncado);
}
