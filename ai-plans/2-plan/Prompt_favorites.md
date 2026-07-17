## Prompt para Implementación Futura: Lista de Favoritos con ❤️

---

### Objetivo

Agregar un botón de "favorito" (corazón) en cada tarjeta de objeto del inventario. El usuario puede hacer toggle del estado favorito: un corazón outline (sin color) se convierte en un corazón completamente rojo con una transición visual rápida pero expresiva. El estado de favorito por usuario se persiste únicamente en `localStorage`. Adicionalmente, al hacer toggle, el frontend envía una solicitud al backend para incrementar o decrementar un contador aproximado de "favoritos" por objeto. El backend mantiene este contador en memoria y lo persiste en Neon cuando el servidor está inactivo por más de 5 minutos. El contador no necesita ser exacto ni transaccional.

---

### Contexto técnico

El frontend es **Angular 17+ standalone** con señales (signals). El backend es **Express + TypeScript** con **PostgreSQL (Neon)** y **Server-Sent Events (SSE)**.

Archivos relevantes:

- `frontend/src/app/components/inventory-list/inventory-list.html` — Template con cuadrícula de objetos en Thumbnail Horizontal Cards (flex row con imagen a la izquierda). Usa `grid grid-cols-1 lg:grid-cols-2 gap-4`. Cada card usa `cursor-pointer` para abrir modal de detalle. **El botón de claim no está aquí; se movió al modal ItemDetail.** El corazón de favorito se agrega dentro del `.relative` contenedor de la imagen.
- `frontend/src/app/components/inventory-list/inventory-list.ts` — Lógica del componente. Inyecta `InventoryService` y `UserService`. Contiene señales de paginación (`currentPage`, `pageSize` como computed), `selectedItem`, filtros, y `effect()`.
- `frontend/src/app/components/item-detail/item-detail.html` — Modal de detalle de item. Contiene el Claim button. El corazón de favorito también debe aparecer aquí (mismo item, mismo estado).
- `frontend/src/app/components/item-detail/item-detail.ts` — Componente del modal. Inyecta `UserService` e `InventoryService`.
- `frontend/src/app/services/inventory.ts` — Servicio que maneja el estado del inventario (`itemsSignal`) y la conexión SSE. Maneja eventos `item_updated`. Aquí se agregará lógica para cargar/guardar favoritos desde `localStorage`, enviar toggle de favorito al backend, y escuchar eventos SSE `favorite_count_updated` para actualizar contadores.
- `frontend/src/app/services/user.ts` — Servicio de sesión. El username actual se usa como key en `localStorage` para los favoritos.
- `shared/types.ts` — Tipos compartidos (`Item`, `ItemStatus`). Se puede extender con `favoriteCount?: number`.
- `backend/src/index.ts` — Punto de entrada. Aquí se agregará la ruta `POST /api/favorites/toggle`.
- `backend/src/config/sse.ts` — Módulo SSE para broadcast de eventos `favorite_count_updated`.
- `backend/src/config/db.ts` — Pool de Neon.
- `backend/src/controllers/feedsController.ts` — Endpoint `GET /api/items` que devuelve items con sus queues. Opcionalmente incluir `favoriteCount`.

---

### Requerimientos funcionales

#### 1. Componente visual del corazón (Frontend)

En cada tarjeta de objeto (tanto en `inventory-list.html` como en `item-detail.html`), sobre la imagen en la esquina superior izquierda, agregar un botón con un ícono de corazón SVG.

**En inventory-list.html**, el contenedor de la imagen es:
```html
<div class="relative w-32 sm:w-36 sm:h-36 shrink-0 bg-gray-50">
  <img [src]="item.imageUrl" [alt]="item.title" class="w-full object-cover" />
  <!-- Status badge at top-2 left-1 -->
  ...
  <!-- Heart button goes here, at top-1 right-1 or similar -->
</div>
```

El badge de estado está en `top-2 left-1`. **El corazón debe ir en `bottom-1 left-1`** para no solaparse con el badge.

**Transición**: Usar CSS `transition-all duration-300` con un `filter: drop-shadow(...)` para visibilidad sobre la imagen. En estado no-favorito: `fill="none" stroke="white"`. En estado favorito: `fill="#EF4444" stroke="#EF4444"` (clases Tailwind `fill-red-500 stroke-red-500`).

#### 2. Persistencia local con localStorage (Frontend)

En `InventoryService`, agregar:

- Una señal `favoriteIds = signal<Set<string>>(new Set())`.
- Una key compuesta: `claimit_favorites_{username}`. Al iniciar sesión o cambiar de usuario, cargar los favoritos correspondientes del `localStorage`.
- Métodos públicos: `toggleFavorite(itemId)`, `isFavorite(itemId)`.
- Métodos privados: `loadFavoritesFromStorage(username)`, `saveFavoritesToStorage(username)`.
- El `Set` se serializa como `JSON.stringify([...set])` y se deserializa como `new Set(JSON.parse(str))`.
- **Nota**: Tanto `InventoryList` como `ItemDetail` necesitan acceder a `isFavorite()` y `toggleFavorite()`. Ambos componentes inyectan `InventoryService`, por lo que los métodos deben ser públicos en el servicio.

#### 3. Envío de toggle al backend (Frontend → REST)

Al hacer toggle, el frontend hace un `POST /api/favorites/toggle` con body `{ itemId, action: 'add' | 'remove' }`.

Usar **optimistic UI**: actualizar el estado local (señal + localStorage) inmediatamente al hacer clic. Si el servidor responde con error, revertir al estado anterior.

#### 4. Endpoint backend para toggle (Backend)

Agregar ruta `POST /api/favorites/toggle` en `index.ts`.

El controlador recibe `{ itemId, action }`, actualiza un `Record<string, number>` en memoria (incrementa o decrementa, mínimo 0), y transmite el nuevo contador vía SSE con `broadcastSseEvent('favorite_count_updated', { itemId, favoriteCount })`.

#### 5. Persistencia ociosa del contador a Neon (Backend)

**Migración SQL** (ejecutar en Neon):

```sql
CREATE TABLE IF NOT EXISTS favorite_counts (
    item_id TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Implementar un timer que se reinicia en cada toggle. Si pasan 5 minutos sin actividad de favoritos, se ejecuta un UPSERT batch: por cada entrada en `favoriteCounts`, hacer `INSERT ... ON CONFLICT (item_id) DO UPDATE SET count = $2, updated_at = NOW()`.

Al iniciar el servidor, cargar todos los contadores desde `favorite_counts` al `Record` en memoria.

**Importante**: El timer de favoritos debe ser independiente del timer de feed_history (si ambos existen, usar variables separadas).

#### 6. Recibir contadores actualizados vía SSE (Frontend)

En el `initializeSseStream()` de `InventoryService`, agregar un event listener para `favorite_count_updated`:

```typescript
eventSource.addEventListener('favorite_count_updated', (event) => {
  const { itemId, favoriteCount } = JSON.parse(event.data);
  this.itemsSignal.update(items =>
    items.map(item =>
      item.id === itemId ? { ...item, favoriteCount } : item
    )
  );
});
```

#### 7. Mostrar contador de favoritos en la UI (Frontend)

En `inventory-list.html` y `item-detail.html`, cerca del corazón o junto a la categoría, mostrar el contador si es > 0:

```html
@if (item['favoriteCount'] && item['favoriteCount'] > 0) {
  <span class="text-[10px] text-red-400 flex items-center gap-0.5">❤️ {{ item['favoriteCount'] }}</span>
}
```

---

### Criterios de aceptación

- [ ] Cada tarjeta de objeto muestra un ícono de corazón (outline blanco con sombra) en la esquina inferior izquierda de la imagen (`bottom-1 left-1`).
- [ ] El corazón también aparece en el modal ItemDetail en la misma posición.
- [ ] Al hacer clic, el corazón cambia de outline blanco a completamente rojo con transición suave (~300ms).
- [ ] Al hacer clic de nuevo, regresa a outline blanco.
- [ ] El estado de favorito persiste en `localStorage` por usuario (key: `claimit_favorites_{username}`).
- [ ] Al cambiar de usuario, se cargan los favoritos del nuevo usuario desde `localStorage`.
- [ ] Al hacer toggle, se envía un POST a `/api/favorites/toggle` con `{ itemId, action }`.
- [ ] El servidor mantiene un contador en memoria por `itemId`.
- [ ] El servidor transmite el contador actualizado a todos los clientes SSE mediante el evento `favorite_count_updated`.
- [ ] El frontend actualiza el contador visible en la tarjeta al recibir el evento SSE.
- [ ] Después de 5 minutos sin actividad de favoritos, el servidor persiste los contadores a la tabla `favorite_counts` en Neon (UPSERT batch).
- [ ] Al reiniciar el servidor, los contadores se cargan desde `favorite_counts`.
- [ ] El contador puede ser inexacto (no requiere consistencia transaccional). Una diferencia de ±1 o ±2 es aceptable.
- [ ] El corazón funciona tanto en la card de la lista como en el modal de detalle.

---

### Notas técnicas adicionales

- **Optimistic UI**: El frontend actualiza el estado local inmediatamente al hacer clic, antes de esperar la respuesta del servidor. Si el servidor falla, se revierte.
- **El contador es aproximado**: No se usa una transacción de base de datos para cada toggle. Solo se persiste en lote (batch) cada 5 minutos de inactividad. Si el servidor se cae antes del flush, se pierden algunos conteos. Esto es intencional y aceptable por diseño.
- **Ubicación del corazón**: El badge de estado está en `top-2 left-1`. El corazón debe ir en `bottom-1 left-1` para evitar solapamiento. Asegurar `z-10`.
- **SVG del corazón**: Usar la ruta estándar del corazón con viewBox="0 0 24 24". Incluir `drop-shadow(0 1px 2px rgba(0,0,0,0.3))` para visibilidad sobre imágenes claras.
- **Mutex en flush**: Usar un flag `isFlushingFavorites` para prevenir escrituras concurrentes a Neon. Si un toggle ocurre durante un flush, el timer se reinicia y el flush se reintenta después del próximo periodo idle.
- **Tipado**: Extender la interfaz `ItemWithQueue` en `inventory.ts` para incluir `favoriteCount?: number`.
- **Separación de timers**: El timer idle de favoritos debe ser independiente del timer idle del feed history. Usar variables separadas.
- **Dos componentes, un servicio**: Tanto `InventoryList` como `ItemDetail` usan el mismo `InventoryService` para el estado de favoritos. No duplicar lógica.
