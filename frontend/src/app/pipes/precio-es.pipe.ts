import { Pipe, PipeTransform } from '@angular/core';
import { formatPrecioEs } from '../utils/precio-es';

/**
 * Formatea un precio visible con separador de miles en formato es-MX:
 * pesos enteros, 0 decimales siempre, TRUNCANDO la parte fraccionaria
 * (sin redondear) y sin `.00` de relleno. El símbolo `$` se conserva en el
 * template (este pipe NO agrega moneda).
 *
 * Ejemplos en el template:
 *   ${{ item.precioVisible | precioEs }}  -> "$100" · "$850" · "$1,500"
 *   Sin precio (null/undefined) -> '' (el bloque @if ya no renderiza nada).
 */
@Pipe({
  name: 'precioEs',
  standalone: true
})
export class PrecioEsPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatPrecioEs(value);
  }
}
