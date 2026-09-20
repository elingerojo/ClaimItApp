
# ClaimItApp

### _"When you want to get rid of stuff before your moving and don't want or don't have the time to carry it to Goodwill places."_ 

#### Just take a picture with your phone and your acquaintance gladly take care of it.

---

Here is the complete, consolidated master plan for your Virtual Moving Giveaway Application. This recap organizes every architectural decision, user experience flow, and database rule we agreed upon into a chronological blueprint, from your initial book photography to the final waitlist processing.

---

## Estrategia temporal v2 (VIGENTE) — contenedor rígido por evento

> Contrato: [`plans/estrategia-temporal-v2.md`](plans/estrategia-temporal-v2.md) (§4 reglas deterministas).
> Las fases que siguen en este README describen el **modelo original/legacy** (deadline por claim y `items.status` de 3 estados); se conservan como historia. El ciclo de vida real lo gestiona **v2**:

- **Contenedor rígido por evento**: `events.claims_close_at` = **T_inicio** (corte de la cola FIFO / comienzo de recolección) y `events.pickup_deadline` = **T_final** (envío a caridad). `published_at`/`available_from` siguen como bases de publicación y disponibilidad.
- **Publicación y "Lo quiero" = dinámico puro (cero columnas por evento)**: la matriz `trust_levels_settings` guarda `advance_pub_hours_default` (visibilidad desde `published_at`) y `advance_disp_hours_default` (inicio de claim desde `available_from`), con `CHECK (advance_disp <= advance_pub)` = nunca se reclama sin ver.
- **Motor de recolección (porciones FIFO constantes, D4)**: familiares 25%, amigos 20%, conocidos 15%, público = `0.6·Vmin` (Vmin = % del rol con ventaja de menor jerarquía presente; 15% si solo público o cola vacía), posición vacía 0%, ventana libre = `100% − Σ`. `V1 = T_inicio + C·s1`, `V2 = V1 + C·s2`, `V3 = V2 + C·s3` con `C = pickup_deadline − claims_close_at`.
- **Congelamiento determinista**: al llegar T_inicio la cola se congela y se persiste `items.frozen_schedule` (snapshot idempotente V1..V3 + ventana libre, `frozen_at`) y en cada claim `fifo_position` + `turn_v_expires_at` (V inmutable); cancelaciones/expirios **no recolocan** los cortes (el dominó hereda el V fijo siguiente).
- **Fases de artículo** (`items.phase`): `claim_open → pickup_turns → ventana_libre | entregado | enviado_a_caridad`. `items.status` (available / waitlist_open / unavailable) se conserva solo como derivado legacy de lectura.
- **Cancelación activa** "Ya no lo quiero" = dominó **neutral** (sin sanción). **Expirio** de turno = `expirado` + sanción de confianza (`expiraciones_acumuladas`, `bloqueado_invitar`, degradación a `publico`, blacklist `bloqueado_apartar`).
- **Ventana libre**: tras agotarse posiciones, cualquiera reclama directo (sin FIFO); el primero se lo lleva (captura inmediata; no cuenta en `max_apartados_simultaneos`).
- **Límite diario por rol** (`trust_levels_settings.max_apartados_diarios`): además del simultáneo, cada rol tiene un tope **por usuario y por día calendario UTC-6**, **global entre eventos**. Cuenta los claims de hoy que NO sean `cancelado_voluntario` (expirio/void/caridad **sí** cuentan); liberar "Ya no lo quiero" devuelve el cupo del día. Aviso suave cuando `remaining <= ceil(0.25·límite)` (cap 5 → avisa al 3º con "Te quedan 2/5"), letrero de estado sobre el botón de claim y bloqueo al agotarse (código `daily_limit_exceeded`); la ventana libre queda exenta. Migración `0008_daily_claim_limit.sql` (seed 5/4/3/2 por rol).
- **Entrega por ADMIN**: 'item recogido' cierra el artículo (`entregado` con `delivered_claim_id`/`delivered_at`), void de los demás activos (cola conservada como registro forense) y detiene los workflows.
- **Caridad**: si al llegar `pickup_deadline` no hubo entrega → `enviado_a_caridad` (`charity_at`), irreversable; purga tras la gracia.

**Scripts de schema y verificación:**
- Reset + re-seed v2 (preserva items vía `scripts/.db-preserved-items.json`, **gitignored**): `node scripts/db-reset.js --yes [--seed]`.
- Verificación read-only del schema v2: `node scripts/db-verify-v2.js`.
- **Verificación E2E del motor v2** (unit del motor puro + integración contra la BD con limpieza, 112 aserciones): `npm --prefix shared run build && npx tsx scripts/test-v2-strategy.ts`.
- **Límite diario de apartados** (helpers puros + integración opcional): `npx tsx scripts/test-daily-limit.ts` (agrega `--db` para la parte contra la BD).
- Migraciones legacy archivadas (solo referencia, no se aplican): `database/migrations/_legacy/`.
- Los tests .ts del modelo legacy (`scripts/test-plan*.ts`, `test-plan2-live.ts`, `test-lazy-catchup.ts`, `test-role-timeline.ts`, `smoke-role-feed.ts`) quedan marcados como **LEGACY / OBSOLETO** en su cabecera.

---

### Análisis de precio de mercado (código de barras → UPCitemdb)

En la **captura** con IA, si Gemini detecta un código UPC/EAN/ISBN (y lo reporta en
`barcode`/`barcodeType`), el backend consulta **UPCitemdb** y calcula
`minPrice`/`maxPrice`/`averagePrice` de las ofertas. El admin los **revisa antes de
guardar** (igual que los campos de Gemini) y al persistir el item se escriben en las
columnas `items.barcode / barcode_type / market_*` (informativo; no altera
`precio_base_costo`). El card de item-detail (admin y visitante) los muestra. La fuente
de precios vive detrás de un adaptador intercambiable
([`backend/src/services/marketPrice.ts`](backend/src/services/marketPrice.ts:1)).

**Variables de entorno (backend/`.env`):**
- `UPCITEMDB_API_KEY` — OPCIONAL. El plan gratuito `/prod` de UPCitemdb NO requiere API key
  (100 peticiones combinadas/día); solo se envía como header `key` si se configura un plan superior.
- `UPCITEMDB_API_URL` — opcional; endpoint de lookup (default `https://api.upcitemdb.com/prod/trial/lookup`).
- `MARKET_LOOKBACK_MONTHS` — opcional; ventana de ofertas en meses (default `6`).

Aplicar la migración sobre una BD viva:
`node scripts/run-migration.js database/migrations/0007_item_market_price_analysis.sql`

---

### Estado físico del item y Detalle descriptivo

Cada item puede llevar, además de la descripción generada por IA, **seis campos
nuevos** que captura el ADMIN. **Todos son opcionales y quedan en `NULL` por
defecto**: `NULL` significa "no proporcionado" y la UI del visitante **no
renderiza elemento alguno** para ese campo (sin chip, sin bloque y sin etiqueta
vacía). Nada rellena retroactivamente los items existentes, así que un catálogo
sin capturas se ve igual que antes de esta función.

| Columna DB | Contrato (`Item`, camelCase) | Etiqueta UI | Tipo |
| :--- | :--- | :--- | :--- |
| `description_detail` | `descriptionDetail` | Detalle descriptivo | `TEXT`, sin mínimo |
| `condition_grade` | `conditionGrade` | Estado físico | `VARCHAR(20)` + `CHECK` |
| `condition_packaging` | `conditionPackaging` | Empaque | `VARCHAR(20)` + `CHECK` |
| `condition_accessories` | `conditionAccessories` | Accesorios | `VARCHAR(20)` + `CHECK` |
| `condition_usage` | `conditionUsage` | Uso | `VARCHAR(20)` + `CHECK` |
| `condition_functionality` | `conditionFunctionality` | Funcionamiento | `VARCHAR(20)` + `CHECK` |

**Convención `Descripción (IA)`:** lo que cambió es **sólo la etiqueta de UI** de
`items.description`, que ahora se lee `Descripción (IA)`; la columna
`items.description` **NO se renombró** (decisión bloqueada del plan), así que el
contrato de la API, el feed, los serializadores y el prompt de Gemini quedan
intactos. El `Detalle descriptivo` (`description_detail`) es un campo
**independiente** de `items.description`: es texto editorial que el ADMIN captura
y edita a mano (y que vuelve a `NULL` si se borra el texto).

**El estado físico es input exclusivo del ADMIN:** nunca se deriva de la
descripción, de la foto ni de otro campo, y Gemini **no sugiere** calificadores
(decisiones 1 y 6 del plan). Es **sólo informativo**: no altera
`precio_base_costo`, ni los multiplicadores por rol, ni el orden del catálogo, ni
la visibilidad, ni las fases, ni las reglas de claim (decisión 5), y no existe
filtrado ni ordenamiento por condición.

**Catálogo ordenado de Estado físico** (`condition_grade`, mejor → peor; es el
orden en que se renderiza el `select` del admin):

| rank | code | Etiqueta UI | Composición típica |
| :--- | :--- | :--- | :--- |
| 7 | `nuevo_sellado` | Nuevo (sellado) | `nuevo` + `original_sellado` + `todos` + `perfecto` |
| 6 | `como_nuevo` | Como nuevo | `usado` + `original_abierto` + `todos` + `como_nuevo` |
| 5 | `excelente` | Excelente | `usado` + `envuelto_sin_caja` + `todos` + `normal` |
| 4 | `bueno` | Bueno | `usado` + `sin_empaque` + `algunos` + `normal` |
| 3 | `regular` | Regular | desgaste visible; funciona `normal` |
| 2 | `con_fallas` | Con fallas | funcionamiento parcial o faltantes importantes |
| 1 | `para_refacciones` | No funciona (para refacciones) | `no_funciona` |

**Vocabularios de los calificadores** (se persiste el código; la etiqueta es sólo
de UI):

- `condition_packaging` (**Empaque**): `original_sellado`, `original_abierto`, `envuelto_sin_caja`, `sin_empaque`.
- `condition_accessories` (**Accesorios**): `todos`, `algunos`, `sin`.
- `condition_usage` (**Uso**): `nuevo`, `usado`.
- `condition_functionality` (**Funcionamiento**): `perfecto`, `como_nuevo`, `normal`, `se_desconoce`, `no_funciona`.

Refinamiento del vocabulario de funcionamiento: el identificador interno es
**`perfecto`** y su etiqueta visible es **`100% (perfecto)`**. Persistir el
literal `'100'` es **inválido** (un identificador numérico en `VARCHAR(20)` +
`CHECK` envejece mal): en la BD y en la API viaja `perfecto`, y el "100%" vive
sólo en la etiqueta.

La fuente única de códigos, etiquetas, orden (rank) y tono de chip es
[`shared/itemCondition.ts`](shared/itemCondition.ts:1), exportada por
[`shared/index.ts`](shared/index.ts:1); las migraciones replican los mismos
`CHECK`.

**Operación:** aplicar las migraciones `0010` y `0011` **antes de arrancar el
backend**, porque el `SELECT` de hidratación del store en RAM y las sentencias
`INSERT`/`RETURNING` ya referencian las columnas nuevas (sin ellas el backend
falla al hidratar y al guardar):

```bash
node scripts/run-migration.js database/migrations/0010_item_description_detail.sql
node scripts/run-migration.js database/migrations/0011_item_physical_condition.sql
```

El seed de demo ([`scripts/db-seed.js`](scripts/db-seed.js:1)) siembra condiciones
variadas para poder ver la matriz completa en un catálogo recién creado: un item
con los 5 campos + detalle, uno con estado físico y 2 calificadores, uno sólo con
estado físico y dos sin ningún campo nuevo.

---

### Phase 1: The Database Schema & Concurrency Design ( Neon[^neon-term] PostgreSQL[^PostgreSQL-term] )

The foundation of the app is a relational database designed to handle high concurrency and prevent race conditions for high-value items.

- **The Items Inventory Table:** Stores the details for everything you are giving away (Books, Furniture, Electronics, Decor, Misc). It contains fields for the Title, Description, Category, External Info Link (e.g., Goodreads or Amazon), and the Vercel[^Vercel-term] Blob[^Blob-term] Image URL.

- **The Three-State System:** To manage availability dynamically, every item tracks its status using three distinct lifecycle phases:

    1. `'available'`: 0 claims. The primary slot is wide open.
    2. `'waitlist_open'`: 1 or 2 claims. The primary slot is taken, but backup runner-up spots are still available.
    3. `'unavailable'`: 3 claims. The item and its waitlist queue are completely full.
    
- **The Claims Ledger Table:** A chronological log tracking every claim. It maps a unique Claim ID to the Item ID, along with the claimant's Name, Email, and a precise database timestamp (`NOW()`). It allows a maximum of 3 sequential rows per item.

- **Race-Condition Protection (Pessimistic Locking):** When a friend clicks "Claim," the database executes an atomic transaction block. It immediately locks that specific item row exclusively (`FOR UPDATE`). Any concurrent requests hitting at the exact same millisecond are forced to wait in a queue. The system evaluates the slots, logs the claim in order, updates the item's status enum, and safely commits the transaction, ensuring zero double-booking.

### Phase 2: The Media Asset Pipeline & AI Ingestion (Vercel[^Vercel-term] Blobs[^Blob-term])
This phase eliminates manual data entry and catalog fatigue while you are busy packing up your house.

- **Direct-to-Blob Mobile Upload:** From your private admin dashboard `/admin/upload` on your phone, you take a photo of an item or a batch of book covers. Your frontend requests a temporary, secure upload token from your backend, allowing your phone to upload the image directly to Vercel[^Vercel-term] Blobs. This bypasses your backend server completely, keeping it lightweight.

- **The AI Auto-Fill Agent:** Once the image is hosted, your backend sends the image URL to a Vision LLM API (like Gemini or OpenAI). The AI analyzes the photo and returns a structured JSON payload containing a suggested Title, Category, and a brief Description (including fetching an external Goodreads or product link if it recognizes a book or specific piece of equipment).

- **Instant Admin Review:** This AI-generated data instantly populates the form fields on your phone screen. You quickly review the text, make any quick manual adjustments, and hit "Save" to push the item live into your Neon database.

#### Blob garbage collection (`scripts/blob-gc.js`)

Because the phone uploads straight to Vercel Blob before the item is ever saved, a blob can exist
in the store without any row in Neon referencing it (an abandoned form, a re-uploaded photo, a
deleted item). This script reclaims that space by comparing the two sides:

1. every `items.image_urls` entry in Neon, normalized to a Blob pathname;
2. every blob in the store, read with the server SDK `list()`.

Anything in the store but not in Neon is an orphan candidate. The default run is a **dry run**, so
nothing is ever deleted without `--delete`:

```bash
npm run blob:gc                 # dry run: report only
npm run blob:gc -- --verbose    # dry run with a per-blob classification
npm run blob:gc --prefix=uploads/
npm run blob:gc:delete          # review the report first, then delete
```

Each run writes `plans/blob-gc-report.json` (full machine-readable detail) and
`plans/blob-gc-orphans.txt` (the candidate list), and both are written **before** any deletion.

Recommended sequence: run `blob:gc`, read the report, confirm the "Kept by Neon" count matches the
store you expect, then run `blob:gc:delete` and re-run `blob:gc` to confirm zero orphans remain.

Safety rules baked into the script:

- **24h grace window** (`--grace-hours=N`). Blobs uploaded recently may belong to a form that is
  still open, so they are reported as *skipped-recent* and never deleted.
- **Fails fast** when `DATABASE_*` or `BLOB_READ_WRITE_TOKEN` are missing, and when the token is a
  placeholder such as `vercel_blob_rw_your_secret_token_here`, which the SDK otherwise reports as
  the misleading `This store does not exist`.
- **Store mismatch guard:** if the token's store id differs from the store the Neon URLs point at,
  the run aborts instead of labelling the whole store as orphaned.
- **Empty-reference guard:** if Neon returns zero image URLs, the run aborts unless
  `--allow-empty-db` is passed, so a bad connection can never wipe the store.
- Blobs are matched by pathname, and deletions run in batches of 50 with a rate-limit retry and a
  per-blob fallback.

Prerequisites: `DATABASE_*` and a real `BLOB_READ_WRITE_TOKEN` in `backend/.env` (override with
`--env=.env.production`). Do not confuse this with `scripts/db-orphan-blobs.js`, which runs the
comparison in the opposite direction and is deprecated for this purpose.

#### Optimización de fotos (subida desde el celular)

Cada foto se comprime **en el teléfono** antes de la subida firmada, así que el store guarda WebP
optimizados y no los JPEG crudos de la cámara (~1.9 MB cada uno).

- **Pipeline**: [`image-compress.worker.ts`](frontend/src/app/utils/image-compress.worker.ts:1)
  decodifica con `createImageBitmap` (aplica la orientación EXIF), dibuja en un `OffscreenCanvas` y
  codifica a **WebP** bajando la calidad hasta el objetivo (~200 KB), con **1280 px** de lado mayor
  y un escalón único a 1024 px si hiciera falta. El re-encode descarta además EXIF/GPS.
- **Degradación ordenada** ([`image-compress.ts`](frontend/src/app/utils/image-compress.ts:1)):
  Web Worker → canvas del hilo principal → archivo original. Nunca bloquea la captura; si una foto
  se sube sin optimizar el admin ve un aviso.
- **Destino en el store**: `event-AAAAMMDD/{timestamp}-{aleatorio}.webp`, con la fecha de **creación
  del evento** en Neon (`events.created_at`, tomada en UTC). Sin evento (items legacy) o evento no
  listado: `event-sin-fecha/`.
- **Límites del servidor** ([`uploadController.ts`](backend/src/controllers/uploadController.ts:1)):
  2 MB por archivo, solo `image/jpeg|png|webp`, solo pathnames bajo `event-`, `addRandomSuffix`
  activo y caché de un año (los pathnames son inmutables).

Verificación en cualquier momento (read-only, no necesita la base de datos):

```bash
npm run blob:sizes                    # totales, promedio, histograma y desglose por carpeta
npm run blob:sizes --prefix=event-    # solo las fotos subidas con la política nueva
npm run blob:sizes --details          # tamaño de cada blob, ordenado de mayor a menor
```

Estado al adoptar la política: **380 fotos = 33.3 MB** (promedio 89.7 KB, máximo 208 KB), todas ya
optimizadas *in place* con `sharp` desde otro workspace, referenciadas por Neon y con **0 huérfanas**
según [`plans/blob-gc-report.json`](plans/blob-gc-report.json:1). Las fotos viejas viven en la raíz
del store (sin prefijo); las nuevas llegan bajo `event-AAAAMMDD/`.

### Phase 3: The Backend API & Real-Time Sync (Railway[^Railway-term])
A minimalistic, high-performance Node.js/TypeScript or Bun backend running on Railway handles the logic and live communication.
- **Lightweight REST Endpoints:**
    - `GET /api/items`: Publicly fetches the entire inventory grid.
    - `POST /api/claims`: Handles incoming name/email submissions using the atomic lock-and-count transaction block.
    - `POST /api/admin/items`: Securely processes new item creations.Server-Sent Events (SSE[^SSE-term]) Streaming: Instead of forcing users to refresh their browsers or setting up complex WebSockets, the backend uses a lightweight SSE[^SSE-term] stream. When a user successfully claims a couch or a book, the backend instantly broadcasts a message containing the Item ID and its new status to all open browser connections.
    
### Phase 4: Frontend UI/UX Experience (Angular v22 on Vercel[^Vercel-term])
The user interface delivers a rich, highly visual, reactive grid using modern Angular features.
- *Persistent User Session (Zero-Friction Loop):* To prevent your friends from typing their name and email over and over again, the app uses Angular Signals bound to browser `localStorage`.
    - The very first time they claim something, they enter their details.
    - For every subsequent item, clicking "Claim" opens a 1-click confirmation modal showing: *"Claiming [Item Name] as [Saved Name]. Confirm?"*
- **Visual Grid States (Tailwind CSS UI):** Items dynamically change their appearance based on their real-time state received via SSE[^SSE-term]:
    - **Available State (🟢 Available):** Crisp, full-color cards with an active primary "Claim This Item" button.
    - **Waitlist Open State (🟡 Claimed - Waitlist Open):** Card remains in full color but gains an amber border/badge. The button switches to an outline style reading "Join Waitlist (Spot #2)" or "(Spot #3)". A small queue timeline appears at the bottom of the card showing who currently holds the primary and secondary slots.
    - **Unavailable State (🔴 Full):** The entire card shifts to a grayscale filter and drops to 50% opacity, fading into the background. The button is completely disabled and reads "Waitlist Full".
    
    ### Phase 5: The Public Claims Log & Admin Release Valve
    Transparency keeps the giveaway fair, while administrative controls prevent ghosting.
    - **The Public Ledger Feed:** A dedicated public route or sliding side panel acts as a live vertical timeline feed (e.g., *"🎉 John Doe just claimed 'MacBook Pro' — 2 mins ago"*). This gamifies the experience and provides absolute clarity on who claimed what first.
    - **The 48-Hour Admin Release Valve:** Inside your private admin panel, you have a "No-Show / Evict" button next to every name in a queue. If the primary claimer does not communicate or show up within 48 hours to pick up their item, you click the button.
    - **The Automated Cascade:** The backend deletes that user's specific claim row. Because the queue relies strictly on the chronological database timestamps, **the first runner-up automatically cascades into the 👑 Primary slot** in real-time. The item's status automatically adjusts, and an integrated mail service (like Resend) fires an automated notification to the new winner letting them know the item is now theirs.
    
    This is the entire system roadmap approved for your virtual moving giveaway.

    ### Funciones básicas


| Acción / Función Básica | Archivo donde se define | Referencia en el Código / Punto de Entrada |
| :--- | :--- | :--- |
| **Ver catálogo de objetos y filtros** | `frontend/src/app/components/inventory-list/inventory-list.ts` | `readonly filteredItems = computed(() => {` |
| **Registrar alias y contacto local** | `frontend/src/app/services/user.ts` | `saveSession(username: string, email: string...` |
| **Reclamar objeto u unirse a lista** | `frontend/src/app/services/inventory.ts` | `async submitClaim(itemId: string, username...` |
| **Bloqueo transaccional de slots (FIFS)** | `backend/src/controllers/claimsController.ts` | `export const createClaim = async (req: Request...` |
| **Bloqueo Pesimista SQL anti-carreras** | `backend/src/controllers/claimsController.ts` | `SELECT id, status FROM items WHERE id = $1 FOR UPDATE` |
| **Escuchar cambios en vivo (SSE Cliente)** | `frontend/src/app/services/inventory.ts` | `const eventSource = new EventSource(...` |
| **Emitir cambios en vivo (SSE Servidor)**| `backend/src/config/sse.ts` | `export const broadcastSseEvent = (event...` |
| **Ver historial global de actividad** | `frontend/src/app/components/activity-log/activity-log.ts` | `private async fetchLedgerHistory() {` |
| **Solicitar firma para subir fotos** | `backend/src/controllers/uploadController.ts` | `const jsonResponse = await handleUpload({` |
| **Analizar imagen con IA Vision** | `backend/src/controllers/analyzerController.ts` | `export const analyzeItem = async (req: Request...` |
| **Insertar nuevo objeto al inventario** | `backend/src/controllers/itemsController.ts` | `INSERT INTO items (title, description...` |
| **Ver tabla de control y waitlists** | `frontend/src/app/components/admin-panel/admin-panel.ts` | `readonly inventoryService = inject(InventoryService);` |
| **Expulsar no-show y cascadear cola** | `backend/src/controllers/adminController.ts` | `export const evictClaimant = async (req: Request...` |

### Deployment Plan


| Etapa de Despliegue | Objetivo Principal | Herramienta / Script de Comprobación y Diagnóstico |
| :--- | :--- | :--- |
| **1. Base de Datos (Neon)** | Activar la base de datos PostgreSQL y migrar tablas, índices y los ENUMs de las 15 categorías. | Consulta DQL en la consola web de Neon o PGAdmin 4 que valide la estructura de datos y restricciones de claves foráneas. |
| **2. Servidor API (Railway)** | Compilar y publicar el backend de Node/Express inyectando las variables de entorno divididas. | Script de diagnóstico `scripts/test-api.js` que realice un `fetch` a `/api/items` y verifique una respuesta HTTP 200 (Arreglo JSON). |
| **3. Almacenamiento (Vercel Blobs)** | Levantar el bucket de archivos y sincronizar los tokens de firma y autorización con el backend. | Petición manual via script a `/api/admin/blob-token` enviando el `X-Admin-Token` para validar el formato de la firma devuelta por Vercel. |
| **4. Frontend (Vercel Angular)** | Compilar la app de Angular v22 enlazando los servicios al dominio de Railway y abriendo el túnel SSE. | Inspección en la pestaña *Network* del navegador (F12) validando que la conexión a `/api/stream` mantenga el estado `EventStream` activo. |


 ---
 _Footnotes:_  
[^neon-term]: **Neon:** A serverless, cloud-native PostgreSQL platform that scales compute up and down automatically. Learn more at the [Neon website](https://neon.tech).

[^PostgreSQL-term]: **PostgreSQL:** A powerful, open-source object-relational database system known for reliability, feature robustness, and performance. Learn more at the [PostgreSQL website](https://PostgreSQL.org).

[^Vercel-term]: **Vercel:** A cloud platform optimized for hosting frontend frameworks, providing automated CI/CD and global edge network delivery for Angular applications. Learn more at the [Vercel website](https://Vercel.com).

[^Blob-term]: **Blob:** A binary large object used to store unstructured data like images, audio, or video in cloud storage.

[^SSE-term]: **SSE:** A web technology enabling a server to push real-time stream updates to a client over a single HTTP connection.

[^Railway-term]: **Railway:** A cloud platform that simplifies application deployment and infrastructure management with minimal configuration. Learn more at the [Railway website](https://Railway.com).