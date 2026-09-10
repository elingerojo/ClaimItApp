/**
 * frontend/src/app/utils/browser-context.ts
 *
 * Detecta si la app corre dentro de un webview in-app (WhatsApp, Facebook,
 * Instagram, etc.) o en modo standalone (PWA).
 *
 * Se usa EXCLUSIVAMENTE como pista de UI para enfatizar una de las opciones de
 * la pantalla de recuperación de identidad; nunca como compuerta que bloquee ni
 * como decisión automática.
 *
 * Limitaciones conocidas (por eso es solo una pista):
 *  - En Android, WhatsApp suele abrir Chrome Custom Tabs, que SÍ comparten
 *    almacenamiento con Chrome (falso positivo).
 *  - En iOS, SFSafariViewController/WKWebView a veces se presentan como Safari
 *    y no exponen el token de la app (falso negativo).
 */
export function isInAppWebview(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

  const ua = navigator.userAgent || '';

  // Android WebView: el token "; wv" en el User-Agent.
  if (/;\s*wv\)/i.test(ua)) return true;

  // Tokens de webviews in-app conocidos.
  const webviewTokens = [
    /FBAN/i,
    /FBAV/i,
    /FB_IAB/i,
    /Instagram/i,
    /Line\//i,
    /WhatsApp/i,
    /GSA\//i,
    /BytedanceWebview/i,
    /TikTok/i,
    /MicroMessenger/i,
    /Pinterest/i
  ];
  if (webviewTokens.some((re) => re.test(ua))) return true;

  // Modo standalone (PWA instalada).
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches
  ) {
    return true;
  }
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;

  return false;
}
