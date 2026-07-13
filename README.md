
# ClaimItApp

### _"When you want to get rid of stuff before your moving and don't want or don't have the time to carry it to Goodwill places."_ 

#### Just take a picture with your phone and your acquaintance gladly take care of it.

---

Here is the complete, consolidated master plan for your Virtual Moving Giveaway Application. This recap organizes every architectural decision, user experience flow, and database rule we agreed upon into a chronological blueprint, from your initial book photography to the final waitlist processing.

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