import { Pipe, PipeTransform } from '@angular/core';
import { formatDateEs } from '../utils/date-es';

/**
 * Modos de formato:
 * - 'short' (default): "mié 3 sep, 1:05 p. m."  (sin año)
 * - 'full':            "mié 3 sep 2026, 1:05 p. m."
 * - 'date':            "3 sep 2026"
 * - 'time':            "1:05 p. m."
 */
export type DateEsMode = 'short' | 'full' | 'date' | 'time';

@Pipe({
  name: 'dateEs',
  standalone: true
})
export class DateEsPipe implements PipeTransform {
  transform(value: string | number | Date | null | undefined, mode: DateEsMode = 'short'): string {
    switch (mode) {
      case 'full':
        return formatDateEs(value, { withWeekday: true, withYear: true, withTime: true });
      case 'date':
        return formatDateEs(value, { withWeekday: false, withYear: true, withDay: true, withTime: false });
      case 'time':
        return formatDateEs(value, { withWeekday: false, withYear: false, withDay: false, withTime: true });
      case 'short':
      default:
        return formatDateEs(value, { withWeekday: true, withYear: false, withTime: true });
    }
  }
}
