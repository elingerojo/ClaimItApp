import { Component, signal, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminTokenService } from '../../services/admin-token';
import { ToastService } from '../../services/toast';

@Component({
  selector: 'app-admin-auth',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './admin-auth.html'
})
export class AdminAuth implements OnInit {
  readonly adminTokenService = inject(AdminTokenService);
  readonly toastService = inject(ToastService);

  readonly password = signal('');

  async ngOnInit(): Promise<void> {
    // Al abrir /admin se valida el token guardado contra el backend.
    await this.adminTokenService.validateSession();
  }

  async onLogin(): Promise<void> {
    const pwd = this.password().trim();
    if (!pwd) {
      this.toastService.error('Ingresa el password del administrador.');
      return;
    }
    try {
      await this.adminTokenService.login(pwd);
      this.password.set('');
      this.toastService.success('Sesión iniciada correctamente.');
    } catch (err: any) {
      this.toastService.error(err?.message || 'Error al iniciar sesión.');
    }
  }

  async onLogout(): Promise<void> {
    await this.adminTokenService.logout();
    this.toastService.info('Sesión cerrada.');
  }
}
