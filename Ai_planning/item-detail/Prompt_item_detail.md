## Prompt para Implementación Futura: Vista Detalle de Item (Modal Overlay)

---

### Objetivo

Al hacer clic en una Thumbnail Horizontal Card de la lista de items, se abre un modal overlay que ocupa todo el viewport y muestra el item seleccionado en un Card Vertical con la imagen a todo lo ancho, los textos de detalle completos, y el Claim button dentro de la misma card. Se regresa a la lista general al hacer clic en un botón ✕ (esquina superior derecha del card) o al tocar fuera del card (sobre el backdrop oscuro semitransparente).

---

### Contexto técnico

El frontend es **Angular 17+ standalone** con señales (signals) y Tailwind CSS.

Archivos relevantes:

- `frontend/src/app/components/inventory-list/inventory-list.html` — Template con la cuadrícula de Thumbnail Horizontal Cards. Cada card tiene imagen a la izquierda y contenido a la derecha. El Claim button está en un container separado debajo del card.
- `frontend/src/app/components/inventory-list/inventory-list.ts` — Lógica del componente. Inyecta `InventoryService` y `UserService`. Tiene método `onClaimItem(itemId)` y señales de filtros.
- `frontend/src/app/services/inventory.ts` — Servicio con `itemsSignal` y tipo `ItemWithQueue` (incluye `queue` con `username`/`claimedAt`).
- `frontend/src/app/services/user.ts` — Servicio de sesión del usuario.
- `shared/types.ts` — Tipo `Item` con `id`, `title`, `description`, `category`, `infoUrl`, `imageUrl`, `status`, `createdAt`.

---

### Requerimientos funcionales

#### 1. Nuevo componente `ItemDetail`

Crear en `frontend/src/app/components/item-detail/` con dos archivos:

- `item-detail.ts` — Componente standalone
- `item-detail.html` — Template del modal overlay

**Inputs del componente:**
- `item: ItemWithQueue` — el item a mostrar
- `onClose: () => void` — función para cerrar el modal (setear `selectedItem = null`)
- Métodos de `UserService` e `InventoryService` para el Claim button (recibidos como inputs o inyectados directamente)

**Template** (en `item-detail.html`):
```html
<!-- Backdrop -->
<div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
     (click)="onClose()">

  <!-- Card vertical (stopPropagation para no cerrar al hacer clic dentro) -->
  <div class="bg-white rounded-2xl shadow-2xl overflow-hidden w-full max-w-lg max-h-[90vh] overflow-y-auto"
       (click)="$event.stopPropagation()">

    <!-- Imagen a todo lo ancho -->
    <div class="relative w-full aspect-video bg-gray-50">
      <img [src]="item.imageUrl" [alt]="item.title" class="w-full h-full object-cover" />
      <button (click)="onClose()"
              class="absolute top-3 right-3 w-8 h-8 bg-black/50 hover:bg-black/70 text-white rounded-full
                     flex items-center justify-center text-sm font-bold transition-colors z-10">
        ✕
      </button>
      <span class="absolute top-3 left-3 text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full border shadow-sm"
            [ngClass]="...">...</span>
    </div>

    <!-- Contenido -->
    <div class="p-6">
      <!-- Categoría -->
      <div class="flex items-center justify-between mb-2">
        <span class="text-xs uppercase font-bold tracking-wider text-gray-400">{{ ... }}</span>
        @if (item.infoUrl) {
          <a ...>Ver Info Externa ↗</a>
        }
      </div>

      <!-- Título -->
      <h2 class="text-xl font-bold text-gray-900">{{ item.title }}</h2>

      <!-- Descripción (sin truncar) -->
      <p class="text-sm text-gray-600 mt-3">{{ item.description || 'Sin descripción adicional.' }}</p>

      <!-- Línea de Espera -->
      <div class="mt-5 pt-4 border-t border-gray-100">
        <div class="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Línea de Espera:</div>
        <div class="flex flex-wrap gap-1.5">
          @for (claimer of item.queue; track claimer.username; let idx = $index) {
            <span ...>{{ ... }}</span>
          } @empty {
            <span class="text-xs text-gray-400 italic">Nadie se ha anotado aún.</span>
          }
        </div>
      </div>

      <!-- Claim button (dentro del card vertical) -->
      <div class="mt-6">
        <!-- Misma lógica de estados que el Claim actual -->
        <button ...>...</button>
      </div>
    </div>

  </div>
</div>
```

#### 2. Integración en `InventoryList`

En `inventory-list.ts`:

```typescript
import { ItemDetail } from '../item-detail/item-detail';

// señal para el item seleccionado
readonly selectedItem = signal<ItemWithQueue | null>(null);

// método para cerrar el detail
closeDetail(): void {
  this.selectedItem.set(null);
}

// imports
imports: [CommonModule, StripAccentsPipe, ItemDetail]
```

En `inventory-list.html`:

1. **Hacer clickeable la Thumbnail Horizontal Card**: Agregar `(click)="selectedItem.set(item)"` y `cursor-pointer` al `div` contenedor de la card (donde actualmente está `flex gap-0 ...`).

2. **Renderizar el modal**: Al final del template (después del `</div>` del `@for`), agregar:

```html
@if (selectedItem(); as item) {
  <app-item-detail
    [item]="item"
    [onClose]="closeDetail.bind(this)"
  />
}
```

#### 3. Claim button dentro del modal

El Claim button debe estar dentro del `p-6` del Card Vertical, en la parte inferior. Usar la misma lógica de estados que el Claim actual:

| Estado | Texto del botón | Deshabilitado |
|--------|----------------|--------------|
| `item.status === 'unavailable'` | "Lista de Espera Llena" | Sí |
| Usuario ya en queue | "✅ Ya estás apuntado" | Sí |
| Usuario no autenticado | "Registra tu alias arriba para obtenerlo" | Sí |
| `item.status === 'available'` | "🙋‍♂️ ¡Anótenme, lo quiero!" | No |
| `item.status === 'waitlist_open'` | "⏳ Unirse a la Lista de Espera" | No |

El ItemDetail debe inyectar `UserService` y `InventoryService` para verificar el estado del usuario y ejecutar `onClaimItem`.

Al hacer clic en el Claim button, se ejecuta el claim. Al finalizar (éxito o error), **no se cierra el modal** — el usuario decide cerrarlo manualmente con ✕ o tocando fuera.

#### 4. Cierre del modal

| Acción | Comportamiento |
|--------|---------------|
| Clic en ✕ | Llama a `onClose()` que ejecuta `selectedItem.set(null)` |
| Clic en backdrop (bg-black/50) | Llama a `onClose()` |
| Clic dentro del card blanco | No cierra (`$event.stopPropagation()`) |

---

### Criterios de aceptación

- [ ] Existe el componente `ItemDetail` en `frontend/src/app/components/item-detail/` con `item-detail.ts` e `item-detail.html`.
- [ ] `ItemDetail` es standalone y recibe `item: ItemWithQueue` y `onClose: () => void` como inputs.
- [ ] La Thumbnail Horizontal Card en `inventory-list.html` tiene `cursor-pointer` y `(click)` que asigna el item a `selectedItem`.
- [ ] Al hacer clic en una card, se abre el modal overlay con backdrop oscuro.
- [ ] El modal muestra el item en Card Vertical con imagen `aspect-video` a todo lo ancho.
- [ ] El título se muestra en `text-xl`, descripción completa sin truncar.
- [ ] El Claim button está dentro del Card Vertical (no en container separado debajo).
- [ ] El ✕ en la esquina superior derecha cierra el modal.
- [ ] El clic fuera del card (backdrop) cierra el modal.
- [ ] El clic dentro del card NO propaga al backdrop (no cierra).
- [ ] El modal respeta `max-w-lg` y `max-h-[90vh]` con scroll interno.
- [ ] No se crean rutas nuevas ni se modifica el router.

---

### Notas técnicas

- **stopPropagation**: Usar `$event.stopPropagation()` en el `div` del card blanco para evitar que clics dentro del modal cierren el overlay.
- **Z-index**: El backdrop usa `z-50` para estar sobre todos los elementos de la página.
- **Bind de onClose**: En el template de inventory-list, pasar `onClose` con `closeDetail.bind(this)` para mantener el contexto correcto, o alternativamente definir `closeDetail` como arrow function.
- **Reutilización del Claim logic**: El ItemDetail puede inyectar `UserService` e `InventoryService` directamente, manteniendo la misma lógica de `isUserInItemQueue()` y `onClaimItem()` que existe en InventoryList.
- **Escape key** (opcional): Agregar `@HostListener('document:keydown.escape')` en ItemDetail para cerrar con tecla Escape.
