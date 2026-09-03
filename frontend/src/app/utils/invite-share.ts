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

/** Construye el enlace de invitación completo para el HOME (usa el origin real). */
export function buildInviteUrl(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/?invite=${encodeURIComponent(code)}`;
}

/** Mensaje neutro (sin roles) que acompaña al enlace en WhatsApp / share. */
export function inviteMessage(link: string): string {
  return `Te invito a este evento 🎉 Entra, mira el catálogo y aparta lo que te guste.\n${link}`;
}

/** URL wa.me con el mensaje ya precargado para "Enviar por WhatsApp". */
export function buildWhatsAppInviteUrl(link: string): string {
  return `https://wa.me/?text=${encodeURIComponent(inviteMessage(link))}`;
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
export async function tryNativeShare(link: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ text: inviteMessage(link) });
      return true;
    } catch {
      /* el usuario canceló o falló → se usa el fallback */
    }
  }
  return false;
}
