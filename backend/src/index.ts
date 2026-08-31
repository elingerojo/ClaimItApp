import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Import our configurations & middleware handlers
import { registerSseClient, initializeFeedHistory } from './config/sse.js';
import { requireAdminCode } from './middleware/adminGuard.js';
import { getAuditLog } from './utils/auditLog.js';
import { resolveSession } from './controllers/sessionController.js';
import { createClaim } from './controllers/claimsController.js';
import { getUploadToken } from './controllers/uploadController.js';
import { analyzeItem } from './controllers/analyzerController.js';
import { createItem, updateItem, deleteItem } from './controllers/itemsController.js';
import { getInventoryFeed, getLedgerFeed } from './controllers/feedsController.js';
import { evictClaimant } from './controllers/adminController.js';
import { createEvent, acceptInvitation, getEvent, listEvents } from './controllers/eventsController.js';

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

/* ==========================================================================
   PUBLIC EVENTS & INVITATIONS ENDPOINTS
   ========================================================================== */
app.get('/api/events', listEvents);
app.get('/api/events/:eventId', getEvent);
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
});

/* ==========================================================================
   ADMIN ASSISTANCE & ASSET MANAGEMENT PIPELINE
   ========================================================================== */
app.post('/api/admin/blob-token', requireAdminCode, getUploadToken);
app.post('/api/admin/analyze-item', requireAdminCode, analyzeItem);
app.post('/api/admin/items', requireAdminCode, createItem);
app.post('/api/admin/events', requireAdminCode, createEvent);
app.post('/api/admin/evict', requireAdminCode, evictClaimant);
app.patch('/api/admin/items/:id', requireAdminCode, updateItem);
app.delete('/api/admin/items/:id', requireAdminCode, deleteItem);

/* ==========================================================================
   ADMIN AUDITING & OPERATIONAL OVERSIGHT
   ========================================================================== */
app.get('/api/admin/audit-log', requireAdminCode, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
  const logs = await getAuditLog(limit);
  res.json({
    count: logs.length,
    entries: logs
  });
});

// Initialize feed history from Neon, then launch the server
initializeFeedHistory().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 ClaimItApp Core Server successfully listening out on port [:${PORT}]`);
  });
});
