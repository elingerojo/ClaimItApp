import { ApplicationConfig, provideBrowserGlobalErrorListeners, LOCALE_ID } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // La app se muestra en español (México). Las fechas se renderizan vía el
    // pipe/helper `dateEs` (Intl es-MX + meses de 3 letras); LOCALE_ID alinea
    // cualquier pipe de @angular/common que pudiera usarse a futuro.
    { provide: LOCALE_ID, useValue: 'es-MX' },
  ],
};

export const railwayApiUrl: string = 'https://aakstrapi-production-2140.up.railway.app/api'; 
