## Prompt para Implementación Futura: Help Icons (❓) en la UI

---

### Objetivo

Agregar un pequeño ícono con el símbolo de interrogación (`?`) al lado de cada elemento interactivo de la UI (inputs, botones, selects) donde el usuario podría necesitar orientación. Al hacer clic (o hover) en el ícono, se despliega un panel informativo simple con instrucciones que explican qué hace ese control, cuándo usarlo, y qué consecuencias tiene. El texto del panel debe ser compatible con el `title` (tooltip) del elemento asociado.

---

### Contexto técnico

El frontend es **Angular 22 standalone** con señales (signals) y Tailwind CSS. Los templates usan la sintaxis `@for`, `@if` de Angular 22.

El proyecto tiene 4 componentes principales con elementos interactivos:

- `frontend/src/app/components/inventory-list/inventory-list.html` — Página principal de objetos. Contiene inputs de sesión (alias, email, phone), botones de filtro (categoría, disponibilidad, "Mis elegidos"), enlaces a información externa, y paginación. **Nota: El botón de claim ya no está en este template; se movió al componente ItemDetail.**
- `frontend/src/app/components/item-detail/item-detail.html` — Modal de detalle de item. Contiene el Claim button dentro del modal (creado en implementación anterior).
- `frontend/src/app/components/admin-ingest/admin-ingest.html` — Panel de administración para subir objetos con cámara + IA. Contiene input de token, input de cámara, formulario (título, categoría, descripción, info URL), botón de guardar, y editor vertical para editar.
- `frontend/src/app/components/admin-manage/admin-manage.html` — Panel de administración para gestionar inventario. Contiene input de token y botones de expulsión por usuario en la tabla.
- `frontend/src/app/components/activity-log/activity-log.html` — Barra lateral de actividad en vivo (solo lectura, sin elementos interactivos).

---

### Requerimientos funcionales

#### 1. Componente Angular reutilizable `HelpIcon`

Crear en `frontend/src/app/components/help-icon/help-icon.ts` un componente standalone que:

- Reciba un `input<string>` obligatorio con el texto de ayuda.
- Muestre un círculo pequeño con el símbolo `?` (fondo gris claro, texto gris oscuro, ~16×16px).
- Al hacer **clic**, muestre/oculte un panel flotante con el texto de ayuda (solución para mobile, donde no hay hover).
- Al hacer **hover** (mouseenter/mouseleave), también muestre/oculte el panel (solución para desktop).
- El panel debe aparecer **arriba** del ícono con una flecha hacia abajo apuntando al ícono.
- El panel debe tener fondo oscuro (gray-900), texto blanco, esquinas redondeadas, sombra suave, y animación de entrada (fade-in + translateY de ~200ms).
- El `title` del botón debe ser el mismo texto de ayuda (para tooltip nativo del navegador como respaldo).
- El panel debe cerrarse al hacer clic fuera del ícono (opcional pero recomendado).

#### 2. Contenido de ayuda centralizado

Crear en `frontend/src/app/components/help-icon/help-content.ts` un objeto constante con los textos de ayuda para cada control. Los textos deben:

- Estar en español, tono amigable pero informativo.
- Explicar **qué hace** el control, **cuándo** usarlo, y **consecuencias** si aplica.
- Ser de 1 a 3 párrafos cortos (30-60 palabras cada uno).
- Usar formato markdown ligero (negritas para énfasis).

Controles que necesitan texto de ayuda:

| Key | Control asociado |
|-----|-----------------|
| `username` | Input de alias/apodo en inventory-list |
| `email` | Input de correo electrónico en inventory-list |
| `phone` | Input de teléfono en inventory-list |
| `saveSession` | Botón "Guardar Datos" en inventory-list |
| `clearSession` | Botón "Cambiar Alias" en inventory-list |
| `filterCategory` | Grupo de botones de filtro por categoría (un solo ícono al lado del label "Categoría:") |
| `filterStatus` | Grupo de botones de filtro por disponibilidad (un solo ícono al lado del label "Disponibilidad:") |
| `myClaims` | Botón "Mis elegidos" en inventory-list |
| `externalInfo` | Link "Ver Info Externa" en cada tarjeta de objeto |
| `claimButton` | Botón de reclamar/apuntarse dentro del modal ItemDetail (en `frontend/src/app/components/item-detail/item-detail.html`) |
| `adminToken` | Input de token de administrador en admin-ingest y admin-manage |
| `cameraUpload` | Input de cámara/subir foto en admin-ingest |
| `itemTitle` | Input de título en el formulario de admin-ingest |
| `itemCategory` | Select de categoría en el formulario de admin-ingest |
| `itemDescription` | Textarea de descripción en el formulario de admin-ingest |
| `itemInfoUrl` | Input de info URL en el formulario de admin-ingest |
| `saveItem` | Botón "Guardar en Inventario" en admin-ingest |
| `evictUser` | Botones de expulsión en admin-manage |

**Nota**: El `claimButton` ya no está en `inventory-list.html`. Se movió al componente `item-detail/item-detail.html`. El ícono de ayuda debe integrarse en el template de ItemDetail, no en InventoryList.

#### 3. Integración en los templates

No se debe agregar un ícono al lado de **cada** botón individual de filtro (serían ~15). En su lugar, agregar un solo ícono al lado del **label** del grupo (ej. "Categoría:" y "Disponibilidad:").

**InventoryList** — Agregar `<app-help-icon>` en:
- Al lado de cada input de sesión (alias, email, phone).
- Al lado del botón "Guardar Datos".
- Al lado del botón "Cambiar Alias".
- Al lado del label "Categoría:" (un ícono para todo el grupo).
- Al lado del label "Disponibilidad:" (un ícono para todo el grupo).
- Al lado del label "Mis Acciones:" o del botón "Mis elegidos".
- Al lado del link "Ver Info Externa" en cada tarjeta.

**ItemDetail** — Agregar `<app-help-icon>` en:
- Al lado del botón de reclamar (dentro del modal).

**AdminIngest** — Agregar `<app-help-icon>` en:
- Al lado del input de Admin Token.
- Al lado del label "Título del Objeto".
- Al lado del label "Categoría".
- Al lado del label "Descripción / Estado".
- Al lado del label "Link de Información Externa".
- Al lado del botón "Guardar en Inventario Activo".

**AdminManage** — Agregar `<app-help-icon>` en:
- Al lado del input de Admin Token.
- Al lado del encabezado "Línea de Espera (Click para expulsar)" en la tabla.

#### 4. Comportamiento en mobile

- El clic (tap) debe abrir el panel de ayuda, ya que no existe hover en dispositivos táctiles.
- El panel debe posicionarse hacia arriba del ícono para no tapar el campo asociado.
- Segundo clic en el ícono o clic fuera del panel debe cerrarlo.

---

### Criterios de aceptación

- [ ] Existe un componente `HelpIcon` standalone y reutilizable en `frontend/src/app/components/help-icon/help-icon.ts`.
- [ ] El ícono `?` se muestra como un círculo pequeño (~16×16px) con fondo gris claro.
- [ ] Al hacer clic en el ícono, se despliega un panel flotante con texto informativo.
- [ ] Al hacer hover en el ícono (desktop), se despliega el mismo panel.
- [ ] El panel tiene animación de entrada (fade-in + deslizamiento hacia arriba, ~200ms).
- [ ] El panel se posiciona arriba del ícono con una flecha apuntando hacia abajo.
- [ ] El panel se cierra al hacer clic fuera o al hacer clic nuevamente en el ícono.
- [ ] Existe un archivo `help-content.ts` con textos de ayuda para todos los controles listados.
- [ ] Cada elemento interactivo en `inventory-list.html` tiene su ícono de ayuda asociado.
- [ ] El Claim button en `item-detail.html` tiene su ícono de ayuda asociado.
- [ ] Cada elemento interactivo en `admin-ingest.html` tiene su ícono de ayuda asociado.
- [ ] Los grupos de filtros tienen un solo ícono al lado del label, no uno por botón.
- [ ] El componente funciona correctamente en mobile (tap para abrir/cerrar).

---

### Notas técnicas

- **Posicionamiento del panel**: Usar `position: absolute` con `bottom: 100%` dentro de un contenedor `position: relative`. La flecha se logra con un pseudo-elemento o un div rotado 45°.
- **Cierre al hacer clic fuera**: Opcional. Se puede implementar con un `HostListener('document:click')` que verifique si el clic fue dentro del componente.
- **Z-index**: El panel debe tener `z-index: 50` o superior para estar sobre otros elementos.
- **No duplicar ayuda**: Si un control ya tiene `title` descriptivo en el HTML actual, el texto del panel debe ser compatible (misma intención, formato más amigable y legible).
- **Registro del componente**: El `HelpIcon` debe importarse en los módulos/componentes que lo usen (InventoryList, ItemDetail, AdminIngest, AdminManage) en su arreglo `imports`.
- **Estilos**: Usar Tailwind CSS existente. Si se necesitan animaciones personalizadas, usar `@keyframes` en el arreglo `styles` del componente.
