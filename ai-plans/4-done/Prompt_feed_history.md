## Prompt para Implementación Futura: Historial de Feed SSE con Caché + Persistencia en Neon

---

### Objetivo

Implementar un sistema donde el servidor mantiene en memoria los últimos **N=50** eventos `item_updated` (los que se disparan cuando alguien reclama un ítem). Cuando un nuevo cliente se conecta al stream SSE, recibe automáticamente esos eventos históricos ("replay"). Periódicamente, cuando el servidor está inactivo por más de 5 minutos, el caché se persiste en Neon para sobrevivir reinicios de Railway.

---

### Contexto técnico

El backend usa **Express + TypeScript** con **PostgreSQL (Neon)** y **Server-Sent Events (SSE)** para actualizaciones en tiempo real.

Archivos relevantes:

- `backend/src/config/sse.ts` — Módulo SSE. Exporta `registerSseClient(res)` para registrar conexiones y `broadcastSseEvent(event, data)` para transmitir eventos a todos los clientes conectados. Mantiene un array `clients: Response[]`.
- `backend/src/config/db.ts` — Pool de conexiones a Neon usando `pg`.
- `backend/src/controllers/claimsController.ts` — Procesa claims (reclamos de objetos) con transacciones atómicas. Al finalizar exitosamente, dispara `broadcastSseEvent('item_updated', {...})` con los datos del claim.
- `backend/src/index.ts` — Punto de entrada. Configura rutas Express e inicializa el servidor.
- `frontend/src/app/services/inventory.ts` — Servicio Angular que obtiene el inventario inicial vía REST (`GET /api/items`) y conecta SSE para mutar el estado en tiempo real con eventos `item_updated`.
- `frontend/src/app/components/activity-log/activity-log.ts` — Componente Angular que muestra el activity log. Actualmente obtiene datos históricos vía `GET /api/ledger`. Ya importa `StripAccentsPipe`.
- `shared/types.ts` — Tipos compartidos entre frontend y backend (`Item`, `Claim`, `ItemStatus`, `ItemCategory`).

---

### Requerimientos funcionales

#### 1. Caché circular en memoria

En `backend/src/config/sse.ts`, agregar un array con tope máximo `N=50`. Cada vez que se ejecuta `broadcastSseEvent`, el evento se agrega al array. Si el array excede N, se descarta el más antiguo (`shift`). El array debe almacenar `{ event: string, data: any, timestamp: Date }`.

#### 2. Replay automático en conexión SSE

En `registerSseClient`, antes de agregar el nuevo cliente al array de clients, iterar el caché y escribir cada evento histórico al nuevo stream en formato SSE estándar (`event: {name}\ndata: {json}\n\n`). Los eventos deben enviarse en orden cronológico ascendente (el más antiguo primero).

#### 3. Persistencia ociosa a Neon

Implementar un timer que se reinicia en cada `broadcastSseEvent`. Si el servidor no emite ningún evento por más de 5 minutos, el caché completo se persiste en una tabla `feed_history` en Neon. La operación debe:

- Iniciar una transacción.
- Ejecutar `DELETE FROM feed_history`.
- Insertar cada evento del caché como una fila (`event_name`, `event_data` como JSONB, `created_at`).
- Hacer COMMIT.
- Usar un mutex (`isFlushing`) para prevenir escrituras concurrentes.

#### 4. Carga al iniciar

Al arrancar el servidor (en `backend/src/index.ts`), leer las últimas N filas de `feed_history` ordenadas por `created_at DESC` y poblar el caché en memoria en orden cronológico ascendente. Si la tabla no existe o está vacía, el caché inicia vacío (no debe impedir el arranque del servidor).

#### 5. Enriquecer evento `item_updated`

En `backend/src/controllers/claimsController.ts`, el `broadcastSseEvent('item_updated', ...)` debe incluir `title`, `category` y `claimedAt` además de los campos existentes (`itemId`, `status`, `username`, `queuePosition`). `title` y `category` se obtienen del item asociado (disponible en la misma transacción). `claimedAt` se obtiene del `RETURNING` del INSERT del claim.

#### 6. Deduplicación en frontend

En `frontend/src/app/components/activity-log/activity-log.ts`, el componente debe recibir datos tanto de `GET /api/ledger` (REST) como del stream SSE (eventos `item_updated` con replay). Usar un `Set<string>` con key compuesta `{username}|{claimed_at}` para descartar eventos duplicados cuando el REST y el SSE se solapan. El componente ya importa `StripAccentsPipe` y `CommonModule`.

---

### Criterios de aceptación

- [ ] Al conectar un nuevo cliente SSE, recibe inmediatamente los últimos 50 eventos `item_updated` en orden cronológico ascendente.
- [ ] El activity log del frontend muestra eventos tanto del REST (`/api/ledger`) como del SSE, sin duplicados visibles.
- [ ] Si el servidor Railway se reinicia, al arrancar carga los últimos 50 eventos desde la tabla `feed_history` en Neon.
- [ ] El servidor no escribe a Neon en cada evento, solo después de 5 minutos sin actividad.
- [ ] Los eventos `item_updated` incluyen `title`, `category` y `claimedAt` para uso directo en el activity log.
- [ ] El caché en memoria no excede N=50 eventos.
- [ ] El flush a Neon usa una transacción con ROLLBACK en caso de error.
- [ ] El arranque del servidor no falla si la tabla `feed_history` no existe.

---

### Notas técnicas

- **Mutex en flush**: Usar un flag `isFlushing` para prevenir escrituras concurrentes a Neon. Si un evento SSE llega durante un flush, el timer se reinicia y el flush se reintenta después del próximo periodo idle.
- **Rollback en flush**: Si el flush falla, se ejecuta ROLLBACK. El caché en memoria se conserva intacto. El error se loggea pero no interrumpe el servidor.
- **Costo Neon**: Con N=50 y ~1 flush cada 5-10 minutos en idle, se estiman ~300 writes/día. El tier gratuito de Neon (100k writes/mes) es suficiente.
- **Orden de eventos**: El caché mantiene orden cronológico ascendente (los más viejos primero). El replay los envía en ese orden para que el frontend los muestre correctamente.
- **Separación de timers**: Si existen otras funcionalidades con persistencia ociosa (ej. contadores de favoritos), cada una debe usar su propio timer independiente.
- **Migración SQL**: Crear la tabla con `CREATE TABLE IF NOT EXISTS feed_history (id SERIAL PRIMARY KEY, event_name TEXT NOT NULL, event_data JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())` e índice en `created_at DESC`.
