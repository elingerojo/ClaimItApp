import type { ItemCategory } from '@claimitapp/shared';

/**
 * frontend/src/app/utils/category-label.ts
 *
 * Fuente ÚNICA de traducción de categorías (ItemCategory) a español para la UI.
 * Centraliza el map que antes vivía en inventory-list.ts. Si cambia la lista de
 * categorías en shared/types.ts, actualizar CATEGORY_LABELS aquí.
 */
export const CATEGORY_LABELS: Record<ItemCategory, string> = {
  Kitchen: 'Cocina',
  Electronics: 'Electrónica',
  Decor: 'Decoración',
  Books: 'Libros',
  Media: 'Medios',
  Clothing: 'Ropa',
  Bedding: 'Blancos',
  Shoes: 'Zapatos',
  Accessories: 'Accesorios',
  Bathroom: 'Baño',
  Office: 'Oficina',
  Utilities: 'Utilería',
  Cleaning: 'Limpieza',
  Sports: 'Deportes',
  'Misc.': 'Varios'
};

/** Traduce una categoría a su etiqueta en español; si es desconocida, la devuelve tal cual. */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return '';
  return CATEGORY_LABELS[category as ItemCategory] ?? category;
}
