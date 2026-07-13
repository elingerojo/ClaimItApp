export type ItemCategory =
  | 'Kitchen'
  | 'Electronics'
  | 'Decor'
  | 'Books'
  | 'Media'
  | 'Clothing'
  | 'Bedding'
  | 'Shoes'
  | 'Accessories'
  | 'Bathroom'
  | 'Office'
  | 'Utilities'
  | 'Cleaning'
  | 'Sports'
  | 'Misc.';

export type ItemStatus = 'available' | 'waitlist_open' | 'unavailable';

export interface Item {
  id: string;
  title: string;
  description: string | null;
  category: ItemCategory;
  infoUrl: string | null;
  imageUrl: string;
  status: ItemStatus;
  createdAt: string;
}

export interface Claim {
  id: string;
  itemId: string;
  username: string; // Swapped out name for nickname entry
  claimantEmail: string | null; // Now explicitly nullable
  claimantPhone: string | null; // Now explicitly nullable
  claimedAt: string;
}

