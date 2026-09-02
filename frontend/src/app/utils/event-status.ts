/**
 * frontend/src/app/utils/event-status.ts
 *
 * Small shared helpers to render an event's lifecycle status in the UI
 * (used by the catalog context strip and the item detail modal).
 */

export function eventStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Borrador';
    case 'scheduled':
      return 'Próximo';
    case 'active':
      return 'Activo';
    case 'closing':
      return 'En recolección';
    case 'closed':
      return 'Cerrado';
    default:
      return status;
  }
}

export function eventStatusBadge(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700';
    case 'scheduled':
      return 'bg-blue-100 text-blue-700';
    case 'closing':
      return 'bg-amber-100 text-amber-700';
    case 'closed':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}
