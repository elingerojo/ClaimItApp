/**
 * frontend/src/app/utils/invite-share.ts
 *
 * Helpers puros para construir y compartir un enlace de invitación.
 *
 * Estrategia acordada:
 * - El enlace compartido SIEMPRE aterriza en el HOME del frontend con el token
 *   como argumento:  https://SITIO/?invite=TOKEN
 *   Al abrirse, la app detecta el argumento y, una vez resuelta la identidad,
 *   acepta la invitación con el rol correspondiente (cascada hacia abajo).
 * - El mensaje es neutro a propósito: NO revela roles ni escalones superiores.
 */

/**
 * Construye el enlace de invitación completo para el HOME (usa el origin real).
 * `apodo` (opcional) es la sugerencia del anfitrión: al abrirlo, el popup de
 * bienvenida llega pre-llenado y editable (nunca crea identidad sin un clic).
 */
export function buildInviteUrl(code: string, apodo?: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = `${origin}/?invite=${encodeURIComponent(code)}`;
  if (apodo && apodo.trim()) return `${base}&apodo=${encodeURIComponent(apodo.trim())}`;
  return base;
}

/** Texto por defecto (neutro, sin roles) que acompaña al enlace. */
export const DEFAULT_INVITE_MESSAGE =
  'Te invito a este evento 🎉 Entra, mira el catálogo y aparta lo que te guste.';

/**
 * Construye el texto que acompaña al enlace en WhatsApp / share.
 * `custom` (opcional) es un mensaje personalizado del ADMIN; si viene vacío o
 * en blanco se usa el mensaje por defecto (DEFAULT_INVITE_MESSAGE). El enlace
 * SIEMPRE se anexa en su propia línea.
 */
export function inviteMessage(link: string, custom?: string): string {
  const body = (custom?.trim() || DEFAULT_INVITE_MESSAGE).trim();
  return `${body}\n${link}`;
}

/** URL wa.me con el mensaje ya precargado para "Enviar por WhatsApp". */
export function buildWhatsAppInviteUrl(link: string, custom?: string): string {
  return `https://wa.me/?text=${encodeURIComponent(inviteMessage(link, custom))}`;
}

/** Copia texto al portapapeles (con fallback legacy). Devuelve true si tuvo éxito. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* caer al fallback */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Comparte vía el "share sheet" nativo (WhatsApp, etc.) cuando está disponible.
 * Devuelve true si se invocó el share; false si el llamador debe usar un
 * fallback (copiar al portapapeles o abrir WhatsApp).
 */
export async function tryNativeShare(link: string, custom?: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text: inviteMessage(link, custom) });
      return true;
    } catch {
      /* el usuario canceló o falló → se usa el fallback */
    }
  }
  return false;
}
