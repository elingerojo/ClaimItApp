import { Injectable, signal } from '@angular/core';
import { Item, ItemStatus } from '@claimitapp/shared';
import { railwayApiUrl } from '../app.config';

export interface QueueEntry {
  userUuid: string;
  username: string;
  claimedAt: string;
}

export interface ItemWithQueue extends Item {
  queue: Array<QueueEntry>;
}

@Injectable({
  providedIn: 'root'
})
export class InventoryService {
  private readonly apiUrl = railwayApiUrl;

  // Core application visual layer signaling pipeline
  private readonly itemsSignal = signal<ItemWithQueue[]>([]);
  readonly items = this.itemsSignal.asReadonly();

  constructor() {
    this.fetchInitialInventory();
    this.initializeSseStream();
  }

  private async fetchInitialInventory(): Promise<void> {
    try {
      const response = await fetch(`${this.apiUrl}/items`);
      if (!response.ok) throw new Error('Failed to retrieve baseline catalog metadata.');
      const data: ItemWithQueue[] = await response.json();
      this.itemsSignal.set(data);
    } catch (error) {
      console.error('Core visual collection mapping failed:', error);
    }
  }

  private initializeSseStream(): void {
    if (typeof window === 'undefined') return;

    const eventSource = new EventSource(`${this.apiUrl}/stream`);

    // Intercept update vectors fired directly out of claims allocation procedures
    eventSource.addEventListener('item_updated', (event: MessageEvent) => {
      const updateData = JSON.parse(event.data) as {
        itemId: string;
        status: ItemStatus;
        userUuid?: string;
        username: string;
        queuePosition: number;
        title?: string;
        description?: string | null;
        infoUrl?: string | null;
        evicted?: boolean;
      };

      // Perform local micro-mutations on the matching array target inside your state tree
      this.itemsSignal.update(currentItems =>
        currentItems.map(item => {
          if (item.id !== updateData.itemId) return item;

          let updatedQueue = item.queue;

          if (updateData.evicted && updateData.userUuid) {
            // Remove evicted user from queue
            updatedQueue = item.queue.filter(q => q.userUuid !== updateData.userUuid);
          } else if (updateData.userUuid) {
            // Only modify queue when event carries a userUuid (absent in title-only edits)
            const userExists = item.queue.some(q => q.userUuid === updateData.userUuid);
            updatedQueue = [...item.queue];
            if (!userExists) {
              updatedQueue.push({
                userUuid: updateData.userUuid,
                username: updateData.username,
                claimedAt: new Date().toISOString()
              });
            }
          }

          return {
            ...item,
            status: updateData.status,
            queue: updatedQueue,
            ...(updateData.title !== undefined && { title: updateData.title }),
            ...(updateData.description !== undefined && { description: updateData.description }),
            ...(updateData.infoUrl !== undefined && { infoUrl: updateData.infoUrl })
          };
        })
      );
    });

    eventSource.onerror = (err) => {
      console.error('SSE Live distribution pipeline disconnected:', err);
    };
  }

  /**
   * Dispatches data out to claims transaction handlers
   */
  async submitClaim(itemId: string, userUuid: string, email: string | null, phone: string | null): Promise<any> {
    const response = await fetch(`${this.apiUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, userUuid, email, phone })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'The system was unable to register your claim request.');
    }
    return result;
  }
}
