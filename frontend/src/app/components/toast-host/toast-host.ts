import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, ToastType } from '../../services/toast';

@Component({
  selector: 'app-toast-host',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './toast-host.html'
})
export class ToastHost {
  readonly toastService = inject(ToastService);

  toastClass(type: ToastType): string {
    const classes: Record<ToastType, string> = {
      success: 'bg-emerald-600 border-emerald-700',
      error: 'bg-red-600 border-red-700',
      info: 'bg-blue-600 border-blue-700',
    };
    return classes[type];
  }
}
