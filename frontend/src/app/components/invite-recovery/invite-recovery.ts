import { AfterViewInit, Component, EventEmitter, Input, Output, signal } from '@angular/core';

/** Opciones de la pantalla de recuperación de identidad. */
export type RecoveryChoice = 'new' | 'existing';

/**
 * Tercera pantalla de Bienvenida: aparece SOLO cuando el apodo ingresado ya está
 * ocupado (409). Pregunta si es la primera vez que se usa el apodo y guía al
 * usuario con dos opciones presentadas como tarjetas-botón.
 *
 * La opción recomendada se pre-selecciona y recibe el foco; el énfasis lo decide
 * el host (p. ej. `isInAppWebview() ? 'existing' : 'new'`).
 */
@Component({
  selector: 'app-invite-recovery',
  standalone: true,
  templateUrl: './invite-recovery.html'
})
export class InviteRecovery implements AfterViewInit {
  /** Apodo en conflicto (el que ya está ocupado en la BD). */
  @Input() alias = '';

  /** Muestra la pista contextual de webview in-app. */
  @Input() showWebviewHint = false;

  private readonly emphasizedSignal = signal<RecoveryChoice>('new');
  /** Opción seleccionada (pre-seleccionada con la recomendada). */
  readonly selected = signal<RecoveryChoice>('new');

  /** Opción que se recomienda y se pre-selecciona. */
  @Input() set emphasized(value: RecoveryChoice) {
    this.emphasizedSignal.set(value);
    this.selected.set(value);
  }

  /** El usuario afirma que es su primera vez (elegir otro alias). */
  @Output() chooseNew = new EventEmitter<void>();
  /** El usuario afirma que el apodo es suyo (adoptar el perfil existente). */
  @Output() claimExisting = new EventEmitter<void>();

  select(choice: RecoveryChoice): void {
    this.selected.set(choice);
  }

  isEmphasized(choice: RecoveryChoice): boolean {
    return this.emphasizedSignal() === choice;
  }

  /** Clases de la tarjeta: seleccionada con borde fuerte; no seleccionada neutra. */
  cardClass(choice: RecoveryChoice): string {
    const base =
      'w-full text-left rounded-xl border px-4 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400 ';
    if (this.selected() === choice) {
      return base + 'border-gray-900 bg-white shadow-sm ring-1 ring-gray-900';
    }
    return base + 'border-gray-200 bg-white hover:bg-gray-50';
  }

  confirm(): void {
    if (this.selected() === 'new') this.chooseNew.emit();
    else this.claimExisting.emit();
  }

  ngAfterViewInit(): void {
    // Foco programático en la opción recomendada (permitir activar con Enter).
    setTimeout(() => {
      const id =
        this.emphasizedSignal() === 'existing'
          ? 'invite-recovery-existing'
          : 'invite-recovery-new';
      document.getElementById(id)?.focus();
    }, 0);
  }
}
