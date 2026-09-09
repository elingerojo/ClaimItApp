import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * frontend/src/app/pipes/markdown.pipe.ts
 *
 * Convierte texto Markdown a HTML seguro para pintarlo con `[innerHTML]`:
 * `marked` (parseo) + `DOMPurify` (saneado). Se usa para las notas de un evento
 * (times_notes / conditions_notes): textos informativos de términos y
 * condiciones, nunca en cálculos.
 */
@Pipe({
  name: 'markdown',
  standalone: true
})
export class MarkdownPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    if (!value) return '';
    // marked.parse es síncrono por defecto (async: false): devuelve string.
    const raw = marked.parse(value, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { html: true }
    });
  }
}

// Añadir a cada enlace generado: abrir en pestaña nueva, sin abrir ventanas ni
// fugas de referrer (contenido autorizado por el admin, pero defensivo).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
