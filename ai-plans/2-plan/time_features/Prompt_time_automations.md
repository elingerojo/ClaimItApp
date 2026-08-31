## Prompt para Implementación Futura: Automatizaciones Temporales + Sistema de Eventos + Roles 1-4

---

### Objetivo

Crear un sistema de **Eventos** que agrupa items del inventario con configuraciones de tiempo compartidas (publicación, disponibilidad, recogida). Los items asignados a un evento heredan automáticamente sus fechas. Cambiar una fecha en el evento la propaga a todos sus items.

Adicionalmente, implementar un **sistema de roles (1-4) con invitaciones en cascada** donde cada usuario tiene un rol global (`familiares > amigos > conocidos > público`) que determina:
- Cuándo puede ver cada item (visibilidad por `visibility_level`)
- Cuánto tiempo de anticipación tiene para reclamar (`advance_hours`)
- Qué links de invitación puede generar para compartir (siguiente nivel abajo)
- Cuánto bonus acumula por referidos (`share_bonus`)

Y 4 automatizaciones temporales: publicación programada, límite de recogida, auto-avance de cola, y liberación por lotes.

---

### Contexto técnico

El backend usa **Express + TypeScript** con **PostgreSQL (Neon)** y **Server-Sent Events (SSE)**. El frontend es **Angular 17+ standalone** con señales (signals) y Tailwind CSS.

Archivos relevantes del backend:

- `backend/src/config/sse.ts` — Módulo SSE con caché de feed history y broadcast.
- `backend/src/config/db.ts` — Pool de conexiones a Neon.
- `backend/src/controllers/sessionController.ts` — Resolución de sesión UUID + alias + `isFromSession`.
- `backend/src/controllers/itemsController.ts` — CRUD de items (`createItem`, `updateItem`).
- `backend/src/controllers/claimsController.ts` — Procesa claims con transacciones, usa `userUuid`.
- `backend/src/controllers/feedsController.ts` — Endpoints públicos `GET /api/items` y `GET /api/ledger`.
- `backend/src/controllers/adminController.ts` — Expulsión manual de claimants por `userUuid`.
- `backend/src/index.ts` — Punto de entrada. Configura rutas e inicializa servidor.

Archivos relevantes del frontend:

- `frontend/src/app/services/inventory.ts` — Servicio con `itemsSignal` y manejo de SSE.
- `frontend/src/app/services/user.ts` — Servicio de sesión del usuario (UUID + alias + `resolveSession()`).
- `frontend/src/app/components/inventory-list/inventory-list.html` — Lista pública de items.
- `frontend/src/app/components/item-detail/item-detail.html` — Modal de detalle de item.
- `frontend/src/app/components/admin-ingest/admin-ingest.html` — Panel admin para crear items.
- `frontend/src/app/components/admin-manage/admin-manage.html` — Panel admin para gestionar.

---

### Sistema de Roles (1-4) e Invitaciones en Cascada

#### Los 4 Roles

| Rol | Valor Numérico | Privilegio |
|-----|:---:|------------|
| `familiares` | 1 | Máximo. Ve todo, tiene más anticipación, puede compartir link de `amigos` |
| `amigos` | 2 | Alto. Ve items con visibilidad 2+, anticipación media, comparte link de `conocidos` |
| `conocidos` | 3 | Medio. Ve items con visibilidad 3+, sin anticipación, comparte link de `público` |
| `público` | 4 | Mínimo. Solo ve items públicos, sin anticipación, **no puede compartir** |

#### Invitación en Cascada

Cada **Evento** tiene 4 links de invitación crípticos (uno por rol). El admin los genera al crear el evento.

```
Ejemplo de cascada:

Admin crea evento "Mudanza Julio"
  ├── Link familiares → Juan (global_role = familiares)
  │     └── Juan comparte → María (global_role = amigos)
  │           └── María comparte → Pedro (global_role = conocidos)
  │                 └── Pedro comparte → Ana (global_role = público)
  └── Link amigos directo → Luis (global_role = amigos)
```

**Regla de herencia:** Cuando un usuario acepta una invitación con un rol de mayor privilegio que su `global_role` actual, su `global_role` se actualiza automáticamente al nuevo rol.

#### Cálculo de Tiempo Efectivo

El tiempo de disponibilidad de un item para un usuario depende de:
1. El `available_from` del evento
2. Las horas de anticipación (`advance_hours`) de su rol
3. Las horas de bonus acumuladas por referidos (`bonus_hours`)

```
effective_available_from = event.available_from 
                         - event.[rol]_advance_hours 
                         - event_members.bonus_hours
```

**Ejemplo:**

| Usuario | Rol | advance_hours | bonus_hours | effective_available_from |
|---------|:---:|:-------------:|:-----------:|:------------------------:|
| María | familiares | 72h | 36h (3 refs) | 11-Jul 22:00 |
| Luis | amigos | 24h | 0h | 14-Jul 10:00 |
| Pedro | conocidos | 0h | 0h | 15-Jul 10:00 |
| Ana | público | 0h | 0h | 15-Jul 10:00 |

*(asumiendo evento.available_from = 15-Jul 10:00)*

#### Visibilidad de Items por Rol

Cada item tiene un campo `visibility_level` (0-4) que determina quién puede verlo:

| visibility_level | Visible para | Descripción |
|:---:|--------------|-------------|
| 0 | Solo admin | Invisible para todos los usuarios |
| 1 | `familiares` | Solo el círculo más íntimo |
| 2 | `amigos+` | familiares + amigos |
| 3 | `conocidos+` | familiares + amigos + conocidos |
| 4 | `público` | Todos (default) |

**Filtro en query:** `WHERE items.visibility_level >= :user_role_value`

#### Incentivo por Compartir

Cada evento tiene configurado, por rol, cuántas horas de bonus gana el que comparte cuando alguien se une por su link.

- Solo el `invited_by` (quien compartió) recibe el bonus
- El bonus se acumula en `event_members.bonus_hours`
- No hay límite de usos por link
- `público` no puede compartir, por lo tanto no tiene bonus configurable

---

### Modelo de Datos

#### Nueva tabla: `event_invitations`

```sql
CREATE TABLE event_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('familiares','amigos','conocidos','publico')),
    code TEXT NOT NULL UNIQUE,        -- hash críptico (ej: "a3Fk8Zw...")
    created_by UUID REFERENCES users(uuid),
    use_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(event_id, role)
);
```

#### Nueva tabla: `event_members`

```sql
CREATE TABLE event_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    user_uuid UUID REFERENCES users(uuid) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('familiares','amigos','conocidos','publico')),
    invited_by UUID REFERENCES users(uuid),
    bonus_hours INTEGER DEFAULT 0,
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(event_id, user_uuid)
);
```

#### Modificar tabla: `users`

```sql
ALTER TABLE users ADD COLUMN global_role TEXT DEFAULT 'publico'
    CHECK (global_role IN ('familiares','amigos','conocidos','publico'));
```

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
    -- Avance por rol (horas de anticipación sobre available_from)
    familiares_advance_hours INTEGER DEFAULT 72,
    amigos_advance_hours INTEGER DEFAULT 24,
    conocidos_advance_hours INTEGER DEFAULT 0,
    publico_advance_hours INTEGER DEFAULT 0,
    -- Bonus por compartir (horas que gana quien refiere)
    familiares_share_bonus INTEGER DEFAULT 0,
    amigos_share_bonus INTEGER DEFAULT 0,
    conocidos_share_bonus INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### Modificar tabla: `items`

```sql
ALTER TABLE items ADD COLUMN event_id UUID REFERENCES events(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN visible_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN available_from TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN expires_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE items ADD COLUMN visibility_level INTEGER DEFAULT 4
    CHECK (visibility_level BETWEEN 0 AND 4);
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
   ├── available_from: 10 julio (base, se ajusta por rol)
   ├── pickup_window_hours: 24 (deadline para recoger)
   ├── familiares_advance_hours: 72 (familiares ven el 7 julio)
   ├── amigos_advance_hours: 24 (amigos ven el 9 julio)
   ├── familiares_share_bonus: 12 (12h extra por referido)
   └── Se generan 4 links de invitación automáticamente

2. Asignar items al evento (batch)
   └── Cada item puede tener visibility_level propio (default 4 = público)

3. Compartir links:
   ├── Admin comparte link de familiares con su círculo cercano
   ├── Familiares ven items con visibility_level ≥ 1 desde el 7 julio
   ├── Familiares comparten → link de amigos → nuevos usuarios ven desde el 9 julio
   └── Ganan bonus_hours por cada persona que se une por su link

4. El evento avanza automáticamente:
   draft → scheduled (cuando se acerca published_at)
        → active (available_from para público llegó)
        → completed (todos recogidos o expirados)

5. Admin puede tener múltiples eventos en paralelo:
   - "Lunes de Mudanza" → activo
   - "Sábado de Electrónica" → programado (solo visible para familiares+amigos)
   - "Remate de Libros" → en preparación (draft, nadie lo ve)
```

---

### Requerimientos Funcionales

#### 1. CRUD de Eventos (Backend)

Endpoints admin:
- `POST /api/admin/events` — Crear evento con todos los campos incluyendo `*_advance_hours`, `*_share_bonus`. Genera automáticamente 4 códigos de invitación crípticos en `event_invitations`.
- `GET /api/admin/events` — Listar todos los eventos con conteo de items y miembros.
- `GET /api/admin/events/:id` — Ver detalle de un evento con sus items, miembros por rol, y links de invitación.
- `PATCH /api/admin/events/:id` — Actualizar fechas del evento. **Propaga los cambios a todos los items del evento** mediante una query UPDATE masiva.
- `DELETE /api/admin/events/:id` — Eliminar evento (los items quedan con `event_id = NULL`).
- `POST /api/admin/events/:id/items` — Asignar items al evento (recibe array de `itemId`).

#### 2. Invitaciones y Membresía

Endpoints públicos (requieren sesión):
- `GET /api/events/:id/invite/:code` — Validar un código de invitación. Retorna `{ eventTitle, role, inviterAlias }`.
- `POST /api/events/:id/join` — Unirse a un evento. Body: `{ code }`. Crea `event_members`. Si el rol es mayor que `global_role`, actualiza `global_role`. Si hay `invited_by` (de `event_invitations.created_by`), suma `bonus_hours` al que invitó.
- `GET /api/events/:id/share-link` — Obtener el link para compartir. El servidor determina el siguiente rol hacia abajo según el `global_role` del usuario. Si el usuario es `público`, retorna error (no puede compartir).

**Regla de cascada para compartir:**

| global_role del usuario | Link que recibe | Código de |
|:----------------------:|:---------------:|:---------:|
| familiares | amigos | event_invitations donde role='amigos' |
| amigos | conocidos | event_invitations donde role='conocidos' |
| conocidos | público | event_invitations donde role='publico' |
| público | ❌ Error | — |

#### 3. Publicación Programada (Inherited)

- `visible_at` del item se hereda del evento (`published_at`).
- Si el item tiene su propio `visible_at`, lo sobreescribe.
- `GET /api/items` filtra: `WHERE (visible_at IS NULL OR visible_at <= NOW())`.
- Además filtra por `visibility_level >= user_role_value`.
- Items visibles pero no disponibles se muestran con indicador "🕐 Próximamente" y la fecha **efectiva** según el rol del usuario (`effective_available_from`).
- El botón de claim está deshabilitado con texto "Próximamente..." hasta `effective_available_from`.

#### 4. Liberación por Lotes (Batch Release)

- `available_from` del item se hereda del evento (pero cada usuario ve su `effective_available_from`).
- Un job `setInterval` cada 60 segundos verifica items cuyo `available_from <= NOW()` y status no es `available`.
- Al liberarse, broadcast `item_updated` vía SSE.
- Múltiples items con el mismo `available_from` se liberan juntos.

#### 5. Límite de Recogida (Pickup Deadline)

- Al crear un claim que queda en primera posición, se le asigna `pickup_deadline = NOW() + pickup_window_hours` (heredado del evento).
- El deadline se muestra al usuario en `item-detail.html`.
- Un job `setInterval` cada 5 minutos verifica deadlines vencidos.
- Si vence, el claim se expulsa y se ejecuta auto-avance de cola.

#### 6. Auto-Avance de Cola (Queue Auto-Advance)

- Función compartida `advanceQueue(itemId)` que:
  1. Obtiene los claims restantes (no picked_up) en orden.
  2. Calcula nuevo status según cantidad: 0 = available, 1-2 = waitlist_open, 3 = unavailable.
  3. Actualiza status del item.
  4. Si hay un nuevo primero, le asigna `pickup_deadline`.
  5. Retorna `{ newStatus, newFirstUsername }`.
- Se usa en 3 lugares: expulsión manual (admin), deadline vencido (job), recogida confirmada.
- Broadcast SSE con contexto: `evictedUsername`, `newFirstUsername`, `reason`.

#### 7. Frontend: Vista Admin de Eventos

Nuevo componente en `frontend/src/app/components/admin-events/`:

```
admin-events/
├── admin-events.html       ← Lista de eventos con status y conteo de miembros por rol
├── admin-events.ts         ← Lógica CRUD
├── admin-event-form.html   ← Formulario crear/editar (incluye advance_hours, share_bonus)
└── admin-event-form.ts
```

Cada evento muestra: nombre, fechas, status, conteo de items, miembros por rol (familiares: 3, amigos: 5, ...), botones editar/eliminar, y los 4 links de invitación (código críptico).

Navegación: Agregar ruta `/admin/events` en `app.routes.ts` y un link en el nav de admin.

#### 8. Frontend: Invitación y Compartir

**Al abrir un link de invitación** (ruta pública):
- Mostrar pantalla con nombre del evento, quién invitó, y el rol que se obtendrá
- Si el usuario no tiene sesión, pedir alias primero (flujo normal de `resolveSession`)
- Llamar `POST /api/events/:id/join` con el código
- Redirigir al home del evento

**Botón "Compartir"** en `item-detail.html`:
- Solo visible si el usuario tiene `global_role` distinto de `público`
- Al hacer clic, llamar `GET /api/events/:id/share-link`
- Mostrar el link generado (o un modal con opciones: WhatsApp, copiar, etc.)
- El texto del botón indica qué rol compartirá: "Invitar a un amigo (recibirán rol de [siguiente nivel])"

#### 9. Frontend: Indicadores para el Usuario

En `inventory-list.html`:
```html
@if (item.visibleAt && !isAvailableForMe(item)) {
  <div class="text-xs text-purple-600 bg-purple-50 rounded-lg px-3 py-1.5 mt-2">
    🕐 Disponible para ti a partir del {{ item.effectiveAvailableFrom | date:'EEE d MMM, h:mm a' }}
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

Indicador de rol en el header:
```html
<span class="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full"
      [class.bg-purple-100]="userService.currentRole() === 'familiares'"
      [class.bg-blue-100]="userService.currentRole() === 'amigos'"
      [class.bg-gray-100]="userService.currentRole() === 'conocidos'"
      [class.bg-gray-200]="userService.currentRole() === 'publico'">
  {{ userService.currentRole() }}
</span>
```

---

### API Endpoints — Resumen

#### Eventos (Admin)
| Método | Ruta | Propósito |
|--------|------|-----------|
| `POST` | `/api/admin/events` | Crear evento + 4 links de invitación |
| `GET` | `/api/admin/events` | Listar eventos con conteos |
| `GET` | `/api/admin/events/:id` | Detalle con items, miembros, links |
| `PATCH` | `/api/admin/events/:id` | Actualizar evento (+ propagación) |
| `DELETE` | `/api/admin/events/:id` | Eliminar evento |
| `POST` | `/api/admin/events/:id/items` | Asignar items en batch |

#### Invitaciones (Público)
| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/api/events/:id/invite/:code` | Validar código de invitación |
| `POST` | `/api/events/:id/join` | Unirse a evento con código |
| `GET` | `/api/events/:id/share-link` | Obtener link para compartir |

#### Claims y Admin
| Método | Ruta | Propósito |
|--------|------|-----------|
| `POST` | `/api/claims/pickup` | Confirmar recogida |
| `POST` | `/api/admin/evict` | Expulsión manual (usa advanceQueue) |

---

### Cambios en Respuestas de Endpoints Existentes

#### `GET /api/items` — Nuevos campos en cada item

```json
{
  "id": "...",
  "title": "...",
  "visibilityLevel": 4,
  "effectiveAvailableFrom": "2026-07-14T10:00:00Z",
  "canClaim": true,
  "eventId": "uuid-del-evento",
  // ... campos existentes
}
```

- `visibilityLevel`: el nivel de visibilidad del item (0-4)
- `effectiveAvailableFrom`: fecha calculada según el rol y bonus del usuario actual
- `canClaim`: `true` si `effectiveAvailableFrom <= NOW()` y el usuario tiene permiso
- `eventId`: el evento al que pertenece (o null)

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

- [ ] Existen las tablas `events`, `event_invitations`, `event_members`.
- [ ] Existen los campos nuevos en `users` (global_role), `items` (visibility_level, event_id, ...), `claims` (pickup_deadline, picked_up).
- [ ] Admin puede crear eventos con roles, anticipaciones, y bonuses configurables.
- [ ] Al crear evento, se generan 4 códigos de invitación crípticos.
- [ ] Admin puede asignar items a un evento en batch.
- [ ] Items heredan `visible_at`, `available_from`, `pickup_window_hours` del evento.
- [ ] Cambiar una fecha en el evento propaga a todos sus items.
- [ ] Items con `visible_at` futuro son invisibles en la lista pública.
- [ ] Items filtran por `visibility_level` según el rol del usuario.
- [ ] Items visibles pero no disponibles muestran "Próximamente" con fecha **efectiva** según el rol.
- [ ] Usuarios pueden unirse a eventos mediante código de invitación.
- [ ] Al unirse, si el rol del código es mayor al `global_role`, se actualiza.
- [ ] El que compartió recibe `bonus_hours` cuando alguien se une por su link.
- [ ] Usuarios `público` no pueden compartir (error al pedir share-link).
- [ ] Al llegar `effective_available_from`, los items se liberan automáticamente.
- [ ] El primero en cola recibe un `pickup_deadline`.
- [ ] Si el deadline vence, el claim se expulsa y la cola avanza.
- [ ] La expulsión manual también ejecuta auto-avance.
- [ ] El frontend muestra indicadores visuales para deadlines, roles, y auto-avances.
- [ ] Múltiples eventos pueden estar en diferentes estados simultáneamente.
- [ ] El sistema funciona sin eventos (items sin `event_id` conservan comportamiento actual).
- [ ] El sistema funciona sin roles (items con `visibility_level=4` y usuarios con `global_role=publico`).

---

### Notas Técnicas

- **Propagación de fechas**: Usar `UPDATE items SET available_from = $1 WHERE event_id = $2` — una sola query, transaccional.
- **Herencia vs Override**: Si el item tiene su propio valor para un campo, ese prevalece sobre el del evento. Esto permite excepciones puntuales.
- **advanceQueue**: Función compartida que recibe `poolClient` para ejecutarse dentro de la transacción del caller. Usada por evicción manual, deadline job, y pickup confirmation.
- **Cálculo de effective_available_from**: Se hace en SQL con `SELECT ... - interval '1 hour' * (event.X_advance_hours + COALESCE(em.bonus_hours, 0))` con LEFT JOIN a `event_members`.
- **Códigos de invitación**: Generar con `crypto.randomBytes(32).toString('hex')` o similar. Almacenar hash en BD, no el código original (por seguridad). El código en el link es el original, el servidor lo hashea para buscar.
- **Frontend existente**: El `InventoryService` ya maneja `item_updated` vía SSE. Los nuevos campos (`evictedUsername`, `newFirstUsername`, `reason`) son adicionales y opcionales.
- **Status de eventos**: `draft` → `scheduled` (cuando falta < 1 día para published_at) → `active` (available_from para público pasado) → `completed` (todos los items recogidos o expirados). El job `updateEventStatus` maneja las transiciones automáticas.
