/**
 * Utilidades para formatear los valores del análisis de precio de mercado
 * (min/max/promedio) obtenidos de la fuente de ofertas (UPCitemdb).
 *
 * Diferencia con `precio-es` (que trunca a pesos enteros MXN con `$` del
 * template): los precios de mercado llegan con una MONEDA DE LA FUENTE que NO
 * es necesariamente MXN (p. ej. USD), así que aquí se conservan 2 decimales y
 * el símbolo/etiqueta de moneda se muestra por separado en el template
 * (`marketCurrency`). No se convierte moneda.
 */
export function formatMarketNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '';
  return new Intl.NumberFormat('es-MX', {
    useGrouping: true,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}
