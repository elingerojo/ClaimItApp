import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastHost } from './components/toast-host/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost],
  template: `
    <router-outlet />
    <app-toast-host />
  `,
  styles: [],
})
export class App {}
