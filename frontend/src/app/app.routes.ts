import { Routes } from '@angular/router';
import { InventoryHome } from './components/inventory-home/inventory-home';
import { AdminIngest } from './components/admin-ingest/admin-ingest';
import { AdminManage } from './components/admin-manage/admin-manage';

export const routes: Routes = [
  { path: '', component: InventoryHome },
  { path: 'admin', redirectTo: 'admin/ingest', pathMatch: 'full' },
  { path: 'admin/ingest', component: AdminIngest },
  { path: 'admin/manage', component: AdminManage }
];
