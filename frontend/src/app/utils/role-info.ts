/**
 * frontend/src/app/utils/role-info.ts
 *
 * Copy en español para comunicar al usuario final las consecuencias de expirar
 * y el nombre legible de su rol. SOLO presentación: los valores de cómputo
 * (umbrales) viven en backend (trustSanctions.ts) y el límite simultáneo llega
 * desde el feed (simultaneousLimit).
 */

export function roleDisplayName(role: string | null | undefined): string {
  switch (role) {
    case 'familiares':
      return 'familia';
    case 'amigos':
      return 'amigos';
    case 'conocidos':
      return 'conocidos';
    case 'publico':
      return 'público';
    default:
      return role ?? '—';
  }
}

/**
 * Consecuencia por rol (GLOBAL en v2) si el usuario no recoge a tiempo su
 * turno (expira en V_N). En la Estrategia v2 el rol es global y la sanción
 * aplica contra `users.global_role` (ver trustSanctions.ts):
 *  - familiares: tolerancia infinita (sin sanción).
 *  - amigos:     al expirar 3 turnos pierde temporalmente el derecho a invitar.
 *  - conocidos:  al expirar 2 turnos su rol baja PERMANENTEMENTE a público.
 *  - publico:    al expirar 1 turno su cuenta se bloquea para nuevas
 *                separaciones (bloqueado_apartar).
 * La CANCELACIÓN voluntaria "Ya no lo quiero" NUNCA sanciona (dominó neutral).
 */
export function roleExpiryConsequence(role: string | null | undefined): string {
  switch (role) {
    case 'familiares':
      return 'No pierdes acceso al expirar (tolerancia ilimitada), pero liberas el objeto para el siguiente en fila.';
    case 'amigos':
      return 'Si dejas expirar 3 turnos, pierdes temporalmente el derecho a invitar a más personas.';
    case 'conocidos':
      return 'Si dejas expirar 2 turnos, tu rol baja permanentemente a público en la app.';
    case 'publico':
      return 'Si dejas expirar 1 turno, tu cuenta se bloquea para nuevas separaciones.';
    default:
      return 'No recoger a tiempo libera el objeto para el siguiente en fila (el expirio sí sanciona; la cancelación voluntaria no).';
  }
}
