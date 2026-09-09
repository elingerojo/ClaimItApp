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

  private async fetchLedgerHistory(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/ledger`);
      if (res.ok) {
        const logs: Array<Omit<LedgerLog, 'kind'>> = await res.json();
        // Register REST keys to avoid SSE duplicates (los del REST siempre son apartados).
        logs.forEach(log => this.seenKeys.add(`claim|${log.username}|${log.claimed_at}`));
        this.activityLogs.set(logs.map(log => ({ ...log, kind: 'claim' as const })));
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
      const key = `${kind}|${data.username}|${timestamp}`;
      if (this.seenKeys.has(key)) return;
      this.seenKeys.add(key);

      // Transform the SSE event into LedgerLog format and prepend to the list.
      const newLog: LedgerLog = {
        kind,
        username: data.username,
        claimed_at: timestamp,
        title: data.title ?? '',
        category: data.category ?? ''
      };

      this.activityLogs.update(current => [newLog, ...current]);
    });

    this.eventSource.onerror = () => {
      console.error('SSE connection error in ActivityLog');
    };
  }
}
