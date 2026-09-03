/**
 * Utilidades para renderizar fechas en es-MX con el MES siempre en formato de
 * 3 letras exacto (ene, feb, ..., sep, oct, nov, dic).
 *
 * Motivación:
 * - El CLDR español de Angular/Intl abrevia septiembre como "sept" (4 letras),
 *   por lo que `MMM` del DatePipe o `dateStyle:'medium'` no garantizan 3 letras.
 * - Los formatos puramente numéricos (p. ej. `MM/dd` o `dd/MM`) son ambiguos
 *   durante los primeros 12 días de cada mes: `09/03` puede leerse como 3 sep
 *   o como 9 mar según la convención. Con el mes escrito en 3 letras
 *   (día + mes), esa confusión desaparece.
 *
 * Por eso aquí se compone el texto con `Intl.DateTimeFormat('es-MX', ...)` para
 * el día de la semana y la hora local, pero se sobrescribe el mes con
 * MESES_CORTOS[getMonth()].
 */

export const MESES_CORTOS = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'
] as const;

export interface FormatDateEsOptions {
  /** Incluye el día de la semana abreviado en es-MX (mié, jue, sáb...). */
  withWeekday?: boolean;
  /** Incluye el año de 4 dígitos. */
  withYear?: boolean;
  /** Incluye el día numérico del mes (1-31). */
  withDay?: boolean;
  /** Incluye la hora local en es-MX (1:05 p. m.). */
  withTime?: boolean;
}

const weekdayFormatter = new Intl.DateTimeFormat('es-MX', { weekday: 'short' });
const timeFormatter = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit' });

/**
 * Formatea `value` en es-MX usando el mes de 3 letras exactas.
 * Devuelve '' si el valor es null/undefined/vacío/no válido.
 *
 * Ejemplos (default conWeekday=true, withTime=true):
 *   'short' (sin año) -> "mié 3 sep, 1:05 p. m."
 *   'full'  (con año) -> "mié 3 sep 2026, 1:05 p. m."
 *   'date'  -> "3 sep 2026"
 *   'time'  -> "1:05 p. m."
 */
export function formatDateEs(
  value: string | number | Date | null | undefined,
  options: FormatDateEsOptions = {}
): string {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const { withWeekday = false, withYear = false, withDay = true, withTime = true } = options;

  const dateBits: string[] = [];
  if (withDay) {
    if (withWeekday) dateBits.push(weekdayFormatter.format(date));
    let dayMonth = `${date.getDate()} ${MESES_CORTOS[date.getMonth()]}`;
    if (withYear) dayMonth += ` ${date.getFullYear()}`;
    dateBits.push(dayMonth);
  }
  const datePart = dateBits.join(' ');

  if (withTime) {
    const timePart = timeFormatter.format(date);
    return datePart ? `${datePart}, ${timePart}` : timePart;
  }
  return datePart;
}
