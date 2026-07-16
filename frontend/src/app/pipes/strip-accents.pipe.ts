import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'stripAccents',
  standalone: true
})
export class StripAccentsPipe implements PipeTransform {
  transform(value: string): string {
    if (!value) return value;

    // Normalize to NFD (Canonical Decomposition) which separates
    // base characters from their diacritical marks (accents, tildes, etc.),
    // then remove all combining diacritical marks (Unicode range \u0300-\u036f).
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
}
