/**
 * frontend/src/app/utils/event-status.ts
 *
 * Helpers para renderizar el ciclo de vida v2 en la UI:
 *  - estatus del EVENTO (draft/scheduled/active/closing/closed)
 *  - FASE del ARTÍCULO v2 (claim_open/pickup_turns/ventana_libre/entregado/
 *    enviado_a_caridad) y el `estado_actual` temporal compacto
 *    (CLAIM_ABIERTO/TURNO_1..3/VENTANA_LIBRE/ENTREGADO/ENVIADO_A_CARIDAD)
 *  - estado de cada claim de la cola (claim_state v2)
 *
 * Todo lo de abajo es SOLO presentación: la fuente de verdad del cómputo
 * vive en el backend (feedsController / queueService) y en shared/types.ts.
 */

import type { ClaimState, ItemPhase } from '@claimitapp/shared';

// ---------------------------------------------------------------------------
// Estatus de EVENTO (v2: draft → scheduled → active → closing → closed)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FASE del artículo v2 (ItemPhase)
// ---------------------------------------------------------------------------

/** Etiqueta legible de la fase v2 del artículo. */
export function phaseLabel(phase: ItemPhase | string | null | undefined): string {
  switch (phase) {
    case 'claim_open':
      return 'Apartados abiertos';
    case 'pickup_turns':
      return 'Turnos de recogida';
    case 'ventana_libre':
      return 'Ventana libre';
    case 'entregado':
      return 'Entregado';
    case 'enviado_a_caridad':
      return 'Enviado a caridad';
    default:
      return phase ?? '';
  }
}

/** Clases Tailwind del badge de fase v2 (para tarjetas de listado). */
export function phaseBadge(phase: ItemPhase | string | null | undefined): string {
  switch (phase) {
    case 'claim_open':
      return 'bg-sky-100 text-sky-700 border-sky-200';
    case 'pickup_turns':
      return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'ventana_libre':
      return 'bg-rose-100 text-rose-700 border-rose-200';
    case 'entregado':
      return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'enviado_a_caridad':
      return 'bg-red-100 text-red-700 border-red-200';
    default:
      return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

/** Emoji compacto de la fase v2. */
export function phaseEmoji(phase: ItemPhase | string | null | undefined): string {
  switch (phase) {
    case 'claim_open':
      return '🙋';
    case 'pickup_turns':
      return '⏰';
    case 'ventana_libre':
      return '🔥';
    case 'entregado':
      return '✅';
    case 'enviado_a_caridad':
      return '💔';
    default:
      return '';
  }
}

/** Texto corto del chip de fase (para la tarjeta del listado). */
export function phaseChipText(phase: ItemPhase | string | null | undefined): string {
  switch (phase) {
    case 'claim_open':
      return 'Reclamo abierto';
    case 'pickup_turns':
      return 'Turnos en curso';
    case 'ventana_libre':
      return '¡Apúrate! Ventana libre';
    case 'entregado':
      return 'Entregado';
    case 'enviado_a_caridad':
      return 'A caridad';
    default:
      return phase ?? '';
  }
}

// ---------------------------------------------------------------------------
// `estado_actual` compacto (v2): CLAIM_ABIERTO / TURNO_1..3 / VENTANA_LIBRE /
// ENTREGADO / ENVIADO_A_CARIDAD
// ---------------------------------------------------------------------------

export function temporalStateLabel(code: string | null | undefined): string {
  switch (code) {
    case 'CLAIM_ABIERTO':
      return 'Apartado abierto';
    case 'TURNO_1':
      return 'Turno de la posición 1';
    case 'TURNO_2':
      return 'Turno de la posición 2';
    case 'TURNO_3':
      return 'Turno de la posición 3';
    case 'VENTANA_LIBRE':
      return 'Ventana libre';
    case 'ENTREGADO':
      return 'Entregado';
    case 'ENVIADO_A_CARIDAD':
      return 'Enviado a caridad';
    default:
      return code ?? '';
  }
}

/** Nº de turno activo (1..3) si `estado_actual` es TURNO_N, o null. */
export function temporalTurnNumber(code: string | null | undefined): number | null {
  const m = /^TURNO_([123])$/.exec(code ?? '');
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Estado de cada claim de la cola (claim_state v2)
// ---------------------------------------------------------------------------

export function claimStateLabel(state: ClaimState | string | null | undefined): string {
  switch (state) {
    case 'active':
      return 'Activo';
    case 'cancelado_voluntario':
      return 'Salió por su cuenta';
    case 'expirado':
      return 'Expiró su turno';
    case 'void':
      return 'Sin derecho';
    default:
      return state ?? '';
  }
}

export function claimStateEmoji(state: ClaimState | string | null | undefined): string {
  switch (state) {
    case 'active':
      return '🟢';
    case 'cancelado_voluntario':
      return '🚪';
    case 'expirado':
      return '⏰';
    case 'void':
      return '⚪';
    default:
      return '';
  }
}
