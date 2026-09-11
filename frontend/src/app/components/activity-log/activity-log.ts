import { Component, signal, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';
import { CategoryEsPipe } from '../../pipes/category-es.pipe';

/** Tipo de renglón del feed de actividad en vivo. */
export type ActivityKind = 'claim' | 'release';

export interface LedgerLog {
  kind: ActivityKind;
  username: string;
  /** Momento del evento: claimed_at para apartados, releasedAt para liberaciones. */
  claimed_at: string;
  title: string;
  category: string;
}

/**
 * Renglón crudo del snapshot REST (`/api/ledger`).
 * `kind` es opcional: en Fase 1 el backend aún no lo emite; se resuelve en el mapeo
 * con el fallback `?? 'claim'` (Fase 2 lo enviará sin tocar el template).
 */
type LedgerApiRow = Omit<LedgerLog, 'kind'> & { kind?: ActivityKind };

@Component({
  selector: 'app-activity-log',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe, DateEsPipe, CategoryEsPipe],
  templateUrl: './activity-log.html'
})
export class ActivityLog implements OnInit, OnDestroy {
  private readonly apiUrl = railwayApiUrl;
  readonly activityLogs = signal<LedgerLog[]>([]);
  private seenKeys = new Set<string>();
  private eventSource: EventSource | null = null;

  ngOnInit(): void {
    this.fetchLedgerHistory().then(() => this.initializeSseStream());
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
  }

  /** Instante del evento: única fuente de parseo del timestamp. */
  private eventAt(log: LedgerLog): number {
    return Date.parse(log.claimed_at);
  }

  /**
   * Ordena por recencia (más reciente primero). Método puro y agnóstico de la fuente:
   * no sabe si los datos vienen de `/api/ledger` o del historial de `/api/stream`.
   */
  private sortByEventTime(logs: LedgerLog[]): LedgerLog[] {
    return [...logs].sort((a, b) => this.eventAt(b) - this.eventAt(a));
  }

  /**
   * Clave compuesta compartida por el dedup y el `track` del template:
   * `kind|username|timestamp`, con el mismo fallback `kind ?? 'claim'`.
   */
  private keyOf(log: { kind?: ActivityKind; username: string; claimed_at: string }): string {
    return `${log.kind ?? 'claim'}|${log.username}|${log.claimed_at}`;
  }

  private async fetchLedgerHistory(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/ledger`);
      if (res.ok) {
        const rows: LedgerApiRow[] = await res.json();
        // Mapeo tolerante: resuelve el fallback aqui, nunca en el template.
        const logs: LedgerLog[] = rows.map(row => ({ ...row, kind: row.kind ?? 'claim' }));
        // Register REST keys to avoid SSE duplicates.
        logs.forEach(log => this.seenKeys.add(this.keyOf(log)));
        this.activityLogs.set(this.sortByEventTime(logs));
      }
    } catch (err) {
      console.error('Failed to load ledger history data views:', err);
    }
  }

  private initializeSseStream(): void {
    if (typeof window === 'undefined') return;

    this.eventSource = new EventSource(`${this.apiUrl}/stream`);

    this.eventSource.addEventListener('item_updated', (event: MessageEvent) => {
      const data = JSON.parse(event.data) as {
        reason?: string;
        username?: string;
        claimedAt?: string;
        releasedAt?: string;
        title?: string;
        category?: string;
        itemId?: string;
        status?: string;
        queuePosition?: number;
      };

      // El feed de actividad en vivo SOLO muestra apartados y liberaciones.
      // Cualquier otro reason (turn_expired, item_frozen, free_window_opened,
      // delivered_by_admin, manual_evict, sent_to_charity, ...) se ignora para
      // no inyectar filas basura tipo 'claimed ""'.
      let kind: ActivityKind | null = null;
      let timestamp: string | undefined;
      switch (data.reason) {
        case 'claim_created':
        case 'ventana_libre_capture':
          kind = 'claim';
          timestamp = data.claimedAt;
          break;
        case 'user_left_voluntarily':
          kind = 'release';
          timestamp = data.releasedAt;
          break;
        default:
          return;
      }

      if (!kind || !data.username || !timestamp) return;

      // Deduplication: skip if we already have this event from REST or a replay.
      const key = this.keyOf({ kind, username: data.username, claimed_at: timestamp });
      if (this.seenKeys.has(key)) return;
      this.seenKeys.add(key);

      // Transform the SSE event into LedgerLog format and re-sort by event time.
      const newLog: LedgerLog = {
        kind,
        username: data.username,
        claimed_at: timestamp,
        title: data.title ?? '',
        category: data.category ?? ''
      };

      this.activityLogs.update(current => this.sortByEventTime([...current, newLog]));
    });

    this.eventSource.onerror = () => {
      console.error('SSE connection error in ActivityLog');
    };
  }
}
