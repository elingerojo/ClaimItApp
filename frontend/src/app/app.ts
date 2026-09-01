import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastHost } from './components/toast-host/toast-host';
import { SiestaBanner } from './components/siesta-banner/siesta-banner';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, SiestaBanner],
  template: `
    <router-outlet />
    <app-toast-host />
    <app-siesta-banner />
  `,
  styles: [],
})
export class App {}
