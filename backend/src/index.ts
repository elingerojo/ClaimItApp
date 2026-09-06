import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Import our configurations & middleware handlers
import { registerSseClient } from './config/sse.js';
import { rehydrateAll } from './cache/appStore.js';
import { requireAdminSession } from './middleware/adminSession.js';
import { getAuditLog } from './utils/auditLog.js';
import { resolveSession } from './controllers/sessionController.js';
import { createClaim, confirmPickup } from './controllers/claimsController.js';
import { startScheduler, runLazyCatchUp } from './services/scheduler.js';
import { getUploadToken } from './controllers/uploadController.js';
import { analyzeItem } from './controllers/analyzerController.js';
import {
  createItem,
  updateItem,
  deleteItem,
  getItemDetail,
  listAllAdminItems
} from './controllers/itemsController.js';
import { getInventoryFeed, getLedgerFeed } from './controllers/feedsController.js';
import { evictClaimant } from './controllers/adminController.js';
import { adminLogin, adminSessionStatus, adminLogout } from './controllers/adminAuthController.js';
import {
  createEvent,
  updateEvent,
  deleteEvent,
  getEventDetail,
  assignItems,
  acceptInvitation,
  getEvent,
  listEvents,
  validateInvitation,
  getShareLink
} from './controllers/eventsController.js';
import {
  getEventConfig,
  updateEventConfig,
  getRoleConfig,
  updateRoleConfig
} from './controllers/configController.js';

// Edit comment to triger redoploy in Railway 

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS so your Vercel client can easily speak with your Railway database instance
app.use(cors({ origin: '*' }));
// Express JSON body routing configuration
app.use(express.json());

/* ==========================================================================
   SESSION & USER IDENTITY ENDPOINTS
   ========================================================================== */
app.post('/api/session', resolveSession);

/* ==========================================================================
   PUBLIC FEEDS & DATA DISCOVERY ENDPOINTS
   ========================================================================== */
app.get('/api/items', getInventoryFeed);
app.get('/api/ledger', getLedgerFeed);
app.post('/api/claims', createClaim);
app.post('/api/claims/pickup', confirmPickup);

/* ==========================================================================
   PUBLIC EVENTS & INVITATIONS ENDPOINTS
   ========================================================================== */
app.get('/api/events', listEvents);
app.get('/api/events/:eventId', getEvent);
app.get('/api/events/:id/invite/:code', validateInvitation);
app.get('/api/events/:id/share-link', getShareLink);
app.post('/api/invitations/accept', acceptInvitation);

/* ==========================================================================
   REAL-TIME DATA STREAM ENTRY ROUTE (SSE ENGINE)
   ========================================================================== */
app.get('/api/stream', (req: Request, res: Response) => {
  // Enforce chunked HTTP parameters required to sustain an open event tunnel
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Establish baseline protocol layer instantly

  registerSseClient(res);

  // Catch-up perezoso al conectar (un usuario está mirando): resuelve
  // deadlines vencidos y avanza la cola. Solo toca Neon si hay vencidos.
  runLazyCatchUp().catch(() => {});
});

/* ==========================================================================
   ADMIN AUTHENTICATION
   ========================================================================== */
app.post('/api/admin/login', adminLogin);
app.get('/api/admin/session', requireAdminSession, adminSessionStatus);
app.post('/api/admin/logout', requireAdminSession, adminLogout);

/* ==========================================================================
   ADMIN ASSISTANCE & ASSET MANAGEMENT PIPELINE
   ========================================================================== */
// blob-token valida la sesión internamente vía clientPayload (SDK de Vercel no envía headers)
app.post('/api/admin/blob-token', getUploadToken);
app.post('/api/admin/analyze-item', requireAdminSession, analyzeItem);
app.post('/api/admin/items', requireAdminSession, createItem);
app.post('/api/admin/events', requireAdminSession, createEvent);
app.get('/api/admin/events/:id', requireAdminSession, getEventDetail);
app.patch('/api/admin/events/:id', requireAdminSession, updateEvent);
app.delete('/api/admin/events/:id', requireAdminSession, deleteEvent);
app.post('/api/admin/events/:id/items', requireAdminSession, assignItems);
app.post('/api/admin/evict', requireAdminSession, evictClaimant);
// Configuración global de eventos: plantilla de agenda + ventajas por rol
// (matriz). Solo admin.
app.get('/api/admin/event-config', requireAdminSession, getEventConfig);
app.put('/api/admin/event-config', requireAdminSession, updateEventConfig);
app.get('/api/admin/role-config', requireAdminSession, getRoleConfig);
app.put('/api/admin/role-config', requireAdminSession, updateRoleConfig);
// Listado admin filtrado por estatus de evento. Se declara ANTES que
// /api/admin/items/:id para que el path fijo no quede oculto por el parámetro.
app.get('/api/admin/items', requireAdminSession, listAllAdminItems);
app.get('/api/admin/items/:id', requireAdminSession, getItemDetail);
app.patch('/api/admin/items/:id', requireAdminSession, updateItem);
app.delete('/api/admin/items/:id', requireAdminSession, deleteItem);

/* ==========================================================================
   ADMIN AUDITING & OPERATIONAL OVERSIGHT
   ========================================================================== */
app.get('/api/admin/audit-log', requireAdminSession, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const logs = await getAuditLog(limit);
  res.json({
    count: logs.length,
    entries: logs
  });
});

// Rehidratar el store en RAM desde Neon (única carga en frío), luego arrancar
rehydrateAll().then(() => {
  // Arrancar las automatizaciones temporales (releaseBatches, verifyDeadlines,
  // updateEventStatus) una vez que el store está listo.
  startScheduler();
  app.listen(PORT, () => {
    console.log(`🚀 ClaimItApp Core Server successfully listening out on port [:${PORT}]`);
  });
});
