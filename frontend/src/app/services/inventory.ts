import { Injectable, signal } from '@angular/core';
import { Item, ItemStatus } from '@claimitapp/shared';
import { railwayApiUrl } from '../app.config';

export interface ItemWithQueue extends Item {
  queue: Array<{ username: string; claimedAt: string }>;
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
        username: string;
        queuePosition: number;
        title?: string;
        description?: string | null;
        infoUrl?: string | null;
      };

      // Perform local micro-mutations on the matching array target inside your state tree
      this.itemsSignal.update(currentItems => 
        currentItems.map(item => {
          if (item.id !== updateData.itemId) return item;

          const userExists = item.queue.some(q => q.username.toLowerCase() === updateData.username.toLowerCase());
          const updatedQueue = [...item.queue];

          if (!userExists) {
            updatedQueue.push({
              username: updateData.username,
              claimedAt: new Date().toISOString()
            });
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
  async submitClaim(itemId: string, username: string, email: string | null, phone: string | null): Promise<any> {
    const response = await fetch(`${this.apiUrl}/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, username, email, phone })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'The system was unable to register your claim request.');
    }
    return result;
  }
}
