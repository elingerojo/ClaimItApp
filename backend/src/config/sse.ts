import { Response } from 'express';

// Memory array to keep track of active HTTP response streams
let clients: Response[] = [];

/**
 * Registers an active client connection into our streaming pool
 */
export const registerSseClient = (res: Response) => {
  clients.push(res);
  
  // Clean up references when a client closes their browser tab
  res.on('close', () => {
    clients = clients.filter(client => client !== res);
  });
};

/**
 * Broadcasts an atomic data payload out to all connected listeners instantly
 */
export const broadcastSseEvent = (event: string, data: any) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  
  clients.forEach(client => {
    client.write(payload);
  });
};
