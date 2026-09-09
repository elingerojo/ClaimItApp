import { Pipe, PipeTransform } from '@angular/core';
import { categoryLabel } from '../utils/category-label';

/**
 * Traduce una categoría (ItemCategory en inglés) a su etiqueta en español.
 * Ejemplo: 'Kitchen' -> 'Cocina'.
 */
@Pipe({
  name: 'categoryEs',
  standalone: true
})
export class CategoryEsPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return categoryLabel(value);
  }
}
