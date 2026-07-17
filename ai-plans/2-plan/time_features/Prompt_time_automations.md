## Prompt para Implementación Futura: Automatizaciones Temporales + Sistema de Eventos

---

### Objetivo

Crear un sistema de **Eventos** que agrupa items del inventario con configuraciones de tiempo compartidas (publicación, disponibilidad, recogida). Los items asignados a un evento heredan automáticamente sus fechas. Cambiar una fecha en el evento la propaga a todos sus items. Adicionalmente, implementar 4 automatizaciones temporales: publicación programada, límite de recogida, auto-avance de cola, y liberación por lotes.

---

### Contexto técnico

El backend usa **Express + TypeScript** con **PostgreSQL (Neon)** y **Server-Sent Events (SSE)**. El frontend es **Angular 17+ standalone** con señales (signals) y Tailwind CSS.

Archivos relevantes del backend:

- `backend/src/config/sse.ts` — Módulo SSE con caché de feed history y broadcast.
- `backend/src/config/db.ts` — Pool de conexiones a Neon.
- `backend/src/controllers/itemsController.ts` — CRUD de items (`createItem`, `updateItem`).
- `backend/src/controllers/claimsController.ts` — Procesa claims (reclamos) con transacciones.
- `backend/src/controllers/feedsController.ts` — Endpoints públicos `GET /api/items` y `GET /api/ledger`.
- `backend/src/controllers/adminController.ts` — Expulsión manual de claimants.
- `backend/src/index.ts` — Punto de entrada. Configura rutas e inicializa servidor.

Archivos relevantes del frontend:

- `frontend/src/app/services/inventory.ts` — Servicio con `itemsSignal` y manejo de SSE.
- `frontend/src/app/services/user.ts` — Servicio de sesión del usuario.
- `frontend/src/app/components/inventory-list/inventory-list.html` — Lista pública de items.
- `frontend/src/app/components/item-detail/item-detail.html` — Modal de detalle de item.
- `frontend/src/app/components/admin-ingest/admin-ingest.html` — Panel admin para crear items.
- `frontend/src/app/components/admin-manage/admin-manage.html` — Panel admin para gestionar.

---

### Modelo de Datos

#### Nueva tabla: `events`

```sql
CREATE TABLE events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    published_at TIMESTAMPTZ NOT NULL,
    available_from TIMESTAMPTZ NOT NULL,
    pickup_window_hours INTEGER NOT NULL DEFAULT 24,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'scheduled', 'active', 'completed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Modificar tabla: `items`

```sql
ALTER TABLE items ADD COLUMN event_id UUID REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN visible_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN available_from TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN expires_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_items_event_id ON items(event_id);
```

#### Modificar tabla: `claims`

```sql
ALTER TABLE claims ADD COLUMN pickup_deadline TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE claims ADD COLUMN picked_up BOOLEAN DEFAULT FALSE;
```

---

### Flujo de Trabajo del Admin

```
1. Crear Evento → "Lunes de Mudanza"
   ├── published_at: 8 julio  (cuando se ve en frontend)
   ├── available_from: 10 julio (cuando se puede reclamar)
   └── pickup_window_hours: 24 (deadline para recoger)

2. Asignar items al evento (batch)

3. El evento avanza automáticamente:
   draft → scheduled (cuando se acerca published_at)
        → active (available_from llegó)
        → completed (todos recogidos o expirados)

4. Admin puede tener múltiples eventos en paralelo:
   - "Lunes de Mudanza" → activo
   - "Sábado de Electrónica" → programado
   - "Remate de Libros" → en preparación (draft)
```

---

### Requerimientos Funcionales

#### 1. CRUD de Eventos (Backend)

Endpoints admin:
- `POST /api/admin/events` — Crear evento con `title`, `description`, `published_at`, `available_from`, `pickup_window_hours`.
- `GET /api/admin/events` — Listar todos los eventos con conteo de items.
- `GET /api/admin/events/:id` — Ver detalle de un evento con sus items.
- `PATCH /api/admin/events/:id` — Actualizar fechas del evento. **Propaga los cambios a todos los items del evento** mediante una query UPDATE masiva.
- `DELETE /api/admin/events/:id` — Eliminar evento (los items quedan con `event_id = NULL`).
- `POST /api/admin/events/:id/items` — Asignar items al evento (recibe array de `itemId`).

#### 2. Publicación Programada (Inherited)

- `visible_at` del item se hereda del evento (`published_at`).
- Si el item tiene su propio `visible_at`, lo sobreescribe.
- `GET /api/items` filtra: `WHERE (visible_at IS NULL OR visible_at <= NOW())`.
- Items visibles pero no disponibles se muestran con indicador "🕐 Próximamente".
- El botón de claim está deshabilitado con texto "Próximamente..." hasta `available_from`.

#### 3. Liberación por Lotes (Batch Release)

- `available_from` del item se hereda del evento.
- Un job `setInterval` cada 60 segundos verifica items cuyo `available_from <= NOW()` y status no es `available`.
- Al liberarse, broadcast `item_updated` vía SSE.
- Múltiples items con el mismo `available_from` se liberan juntos.

#### 4. Límite de Recogida (Pickup Deadline)

- Al crear un claim que queda en primera posición, se le asigna `pickup_deadline = NOW() + pickup_window_hours` (heredado del evento).
- El deadline se muestra al usuario en `item-detail.html`.
- Un job `setInterval` cada 5 minutos verifica deadlines vencidos.
- Si vence, el claim se expulsa y se ejecuta auto-avance de cola.

#### 5. Auto-Avance de Cola (Queue Auto-Advance)

- Función compartida `advanceQueue(itemId)` que:
  1. Obtiene los claims restantes (no picked_up) en orden.
  2. Calcula nuevo status según cantidad: 0 = available, 1-2 = waitlist_open, 3 = unavailable.
  3. Actualiza status del item.
  4. Si hay un nuevo primero, le asigna `pickup_deadline`.
  5. Retorna `{ newStatus, newFirstUsername }`.
- Se usa en 3 lugares: expulsión manual (admin), deadline vencido (job), recogida confirmada.
- Broadcast SSE con contexto: `evictedUsername`, `newFirstUsername`, `reason`.

#### 6. Frontend: Vista Admin de Eventos

Nuevo componente en `frontend/src/app/components/admin-events/`:

```
admin-events/
├── admin-events.html       ← Lista de eventos con status
├── admin-events.ts         ← Lógica CRUD
├── admin-event-form.html   ← Formulario crear/editar
└── admin-event-form.ts
```

Cada evento muestra: nombre, fechas, status, conteo de items, botones editar/eliminar.

Navegación: Agregar ruta `/admin/events` en `app.routes.ts` y un link en el nav de admin.

#### 7. Frontend: Indicadores para el Usuario

En `inventory-list.html`:
```html
@if (item.visibleAt && !isAvailable(item)) {
  <div class="text-xs text-purple-600 bg-purple-50 rounded-lg px-3 py-1.5 mt-2">
    🕐 Disponible para apartar a partir del {{ item.availableFrom | date:'EEE d MMM, h:mm a' }}
  </div>
}
```

En `item-detail.html`:
```html
@if (esPrimeroEnFila) {
  <div class="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 mt-2">
    ⏰ Tienes hasta {{ pickupDeadline | date:'EEE d MMM, h:mm a' }} para recoger.
  </div>
}
@if (nuevoPrimero) {
  <div class="text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2 mt-2">
    👑 Ahora eres el primero en la fila!
  </div>
}
```

---

### API Endpoints — Resumen

| Método | Ruta | Autenticación | Propósito |
|--------|------|---------------|-----------|
| `POST` | `/api/admin/events` | Admin token | Crear evento |
| `GET` | `/api/admin/events` | Admin token | Listar eventos |
| `GET` | `/api/admin/events/:id` | Admin token | Detalle de evento |
| `PATCH` | `/api/admin/events/:id` | Admin token | Actualizar evento (+ propagación) |
| `DELETE` | `/api/admin/events/:id` | Admin token | Eliminar evento |
| `POST` | `/api/admin/events/:id/items` | Admin token | Asignar items en batch |
| `POST` | `/api/claims/pickup` | Público | Confirmar recogida |
| `POST` | `/api/admin/evict` | Admin token | Expulsión manual (usa advanceQueue) |

---

### Jobs Programados (Scheduler)

Todos en `backend/src/services/scheduler.ts` (nuevo archivo):

| Job | Intervalo | Propósito |
|-----|-----------|-----------|
| `releaseBatches` | 60s | Liberar items cuyo `available_from` ya llegó |
| `verifyDeadlines` | 5 min | Expulsar claims con `pickup_deadline` vencido |
| `updateEventStatus` | 5 min | Avanzar status de eventos (draft→scheduled→active→completed) |

Inicializar jobs en `backend/src/index.ts` después de `initializeFeedHistory()`.

---

### Criterios de Aceptación

- [ ] Existe la tabla `events` y los campos nuevos en `items` y `claims`.
- [ ] Admin puede crear eventos con todas las fechas configurables.
- [ ] Admin puede asignar items a un evento en batch.
- [ ] Items heredan `visible_at`, `available_from`, `pickup_window_hours` del evento.
- [ ] Cambiar una fecha en el evento propaga a todos sus items.
- [ ] Items con `visible_at` futuro son invisibles en la lista pública.
- [ ] Items visibles pero no disponibles muestran "Próximamente" con fecha.
- [ ] Al llegar `available_from`, los items se liberan automáticamente.
- [ ] El primero en cola recibe un `pickup_deadline`.
- [ ] Si el deadline vence, el claim se expulsa y la cola avanza.
- [ ] La expulsión manual también ejecuta auto-avance.
- [ ] El frontend muestra indicadores visuales para deadlines y auto-avances.
- [ ] Múltiples eventos pueden estar en diferentes estados simultáneamente.
- [ ] El sistema funciona sin eventos (items sin `event_id` conservan comportamiento actual).

---

### Notas Técnicas

- **Propagación de fechas**: Usar `UPDATE items SET available_from = $1 WHERE event_id = $2` — una sola query, transaccional.
- **Herencia vs Override**: Si el item tiene su propio valor para un campo, ese prevalece sobre el del evento. Esto permite excepciones puntuales.
- **advanceQueue**: Función compartida que recibe `poolClient` para ejecutarse dentro de la transacción del caller. Usada por evicción manual, deadline job, y pickup confirmation.
- **Frontend existente**: El `InventoryService` ya maneja `item_updated` vía SSE. Los nuevos campos (`evictedUsername`, `newFirstUsername`, `reason`) son adicionales y opcionales.
- **Status de eventos**: `draft` → `scheduled` (cuando falta < 1 día para published_at) → `active` (available_from pasado) → `completed` (todos los items recogidos o expirados). El job `updateEventStatus` maneja las transiciones automáticas.
