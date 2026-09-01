import { Component, inject } from '@angular/core';
import { SiestaService } from '../../services/siesta';

@Component({
  selector: 'app-siesta-banner',
  standalone: true,
  templateUrl: './siesta-banner.html'
})
export class SiestaBanner {
  readonly siestaService = inject(SiestaService);
}
