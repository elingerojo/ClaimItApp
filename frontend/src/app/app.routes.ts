import { Routes } from '@angular/router';
import { InventoryHome } from './components/inventory-home/inventory-home';
import { AdminIngest } from './components/admin-ingest/admin-ingest';
import { AdminManage } from './components/admin-manage/admin-manage';
import { AdminEvents } from './components/admin-events/admin-events';
import { AdminConfig } from './components/admin-config/admin-config';
import { EventInvitation } from './components/event-invitation/event-invitation';

export const routes: Routes = [
  { path: '', component: InventoryHome },
  { path: 'admin', redirectTo: 'admin/ingest', pathMatch: 'full' },
  { path: 'admin/ingest', component: AdminIngest },
  { path: 'admin/manage', component: AdminManage },
  { path: 'admin/events', component: AdminEvents },
  { path: 'admin/config', component: AdminConfig },
  { path: 'events/:id/invite/:code', component: EventInvitation }
];
