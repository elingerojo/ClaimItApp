import { Component, signal, inject, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';
import { DateEsPipe } from '../../pipes/date-es.pipe';

export interface LedgerLog {
  username: string;
  claimed_at: string;
  title: string;
  category: string;
}

@Component({
  selector: 'app-activity-log',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe, DateEsPipe],
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
        const logs: LedgerLog[] = await res.json();
        // Register REST keys to avoid SSE duplicates
        logs.forEach(log => this.seenKeys.add(`${log.username}|${log.claimed_at}`));
        this.activityLogs.set(logs);
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
        username: string;
        claimedAt: string;
        title: string;
        category: string;
        itemId: string;
        status: string;
        queuePosition: number;
      };

      // Deduplication: skip if we already have this event from REST
      const key = `${data.username}|${data.claimedAt}`;
      if (this.seenKeys.has(key)) return;
      this.seenKeys.add(key);

      // Transform the SSE event into LedgerLog format and prepend to the list
      const newLog: LedgerLog = {
        username: data.username,
        claimed_at: data.claimedAt,
        title: data.title,
        category: data.category
      };

      this.activityLogs.update(current => [newLog, ...current]);
    });

    this.eventSource.onerror = () => {
      console.error('SSE connection error in ActivityLog');
    };
  }
}
