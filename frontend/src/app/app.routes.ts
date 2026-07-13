import { Routes } from '@angular/router';
import { InventoryHome } from './components/inventory-home/inventory-home';
import { AdminPanel } from './components/admin-panel/admin-panel';

export const routes: Routes = [
  { path: '', component: InventoryHome }, // 🏠 Página de Inicio: Catálogo + Barra Lateral SSE
  { path: 'admin', component: AdminPanel }  // 🛠️ Panel de administración secreto
];
