import { Pipe, PipeTransform } from '@angular/core';
import { formatMarketNumber } from '../utils/market-price';

/**
 * Formatea un valor del análisis de precio de mercado (min/max/promedio) con
 * separador de miles y 2 decimales (es-MX). NO agrega símbolo de moneda: la
 * moneda de la fuente (`marketCurrency`, p. ej. USD) se muestra aparte en el
 * template para no confundirla con los `$` MXN de `precioVisible`.
 *
 * Ejemplo: 1499.5 -> "1,499.50" (o "1,499,50" según el locale del navegador)
 *          null/undefined/NaN -> ''
 */
@Pipe({
  name: 'marketEs',
  standalone: true
})
export class MarketEsPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatMarketNumber(value);
  }
}
