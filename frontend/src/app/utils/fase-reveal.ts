/**
 * frontend/src/app/utils/fase-reveal.ts
 *
 * Revelado progresivo del renglón de filtro 'Fase:' en la página principal.
 *
 * Una sola clave en localStorage (`claimit_fase_contador`) con formato `N|YYYY-MM-DD`:
 *  - Dispositivo nuevo (sin clave) → se escribe `4|<hoy>` → sección oculta desde el día 1.
 *  - Cada día calendario distinto (diferente al último registrado) resta 1.
 *  - Al llegar a 0 la clave NO se borra: se conserva como `0|...` = revelado
 *    permanente (visible para siempre).
 *
 * No depende de claimit_uuid ni de ninguna otra variable: la regla de decisión
 * es binaria y se deriva únicamente de esta clave.
 *
 *  - Sin clave        → dispositivo nuevo → escribir 4 → OCULTO.
 *  - Valor > 0        → contando días     → OCULTO.
 *  - Valor == 0       → revelado          → VISIBLE.
 *
 * Todo esto es SOLO presentación; no afecta la operación de reclamos.
 */

export const FASE_REVEAL_KEY = 'claimit_fase_contador';

/** Valor inicial de la cuenta regresiva (5 días de uso distintos => revelar). */
const FASE_START = 4;

/** Fecha calendario local (sin horas) en formato YYYY-MM-DD. */
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Lee {n, lastDay} actuales, o null si la clave no existe / está corrupta. */
function read(): { n: number; lastDay: string } | null {
  const raw = localStorage.getItem(FASE_REVEAL_KEY);
  if (!raw) return null;
  const sep = raw.lastIndexOf('|');
  if (sep < 0) return null;
  const n = parseInt(raw.slice(0, sep), 10);
  const lastDay = raw.slice(sep + 1);
  if (Number.isNaN(n)) return null;
  return { n, lastDay };
}

/**
 * Ejecuta la lógica de revelado y devuelve si la sección debe mostrarse.
 * Debe llamarse una vez por carga de la página principal (ngOnInit).
 */
export function faseSectionVisible(): boolean {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return true;

  const today = todayLocal();
  const current = read();

  // Dispositivo nuevo: iniciar cuenta regresiva (sección oculta desde el día 1).
  if (!current) {
    localStorage.setItem(FASE_REVEAL_KEY, `${FASE_START}|${today}`);
    return false;
  }

  // Ya revelado permanentemente (contador en 0): visible siempre.
  if (current.n <= 0) return true;

  // Mismo día calendario: no se vuelve a restar en la misma jornada.
  if (current.lastDay === today) return false;

  // Día calendario distinto: restar 1 (sin pasar de 0).
  const next = Math.max(0, current.n - 1);
  localStorage.setItem(FASE_REVEAL_KEY, `${next}|${today}`);
  return next === 0;
}
