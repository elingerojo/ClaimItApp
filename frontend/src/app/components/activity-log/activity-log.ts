import { Component, signal, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { railwayApiUrl } from '../../app.config';
import { StripAccentsPipe } from '../../pipes/strip-accents.pipe';

export interface LedgerLog {
  username: string;
  claimed_at: string;
  title: string;
  category: string;
}

@Component({
  selector: 'app-activity-log',
  standalone: true,
  imports: [CommonModule, StripAccentsPipe],
  templateUrl: './activity-log.html' // 📂 Relative target mapping matches internal folder setup
})
export class ActivityLog implements OnInit {
  private readonly apiUrl = railwayApiUrl;
  readonly activityLogs = signal<LedgerLog[]>([]);

  ngOnInit(): void {
    this.fetchLedgerHistory();
  }

  private async fetchLedgerHistory(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/ledger`);
      if (res.ok) {
        const logs = await res.json();
        this.activityLogs.set(logs);
      }
    } catch (err) {
      console.error('Failed to load ledger history data views:', err);
    }
  }
}
