import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InventoryList } from '../inventory-list/inventory-list';
import { ActivityLog } from '../activity-log/activity-log';
import { InvitePanel } from '../invite-panel/invite-panel';

@Component({
  selector: 'app-inventory-home',
  standalone: true,
  imports: [CommonModule, InventoryList, ActivityLog, InvitePanel], // 🧠 Registramos los subcomponentes aquí
  templateUrl: './inventory-home.html'
})
export class InventoryHome {}
