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
  userUuid: string;        // UUID del usuario (identificador real)
  username: string;        // Alias actual del usuario (texto decorativo)
  claimantEmail: string | null;
  claimantPhone: string | null;
  claimedAt: string;
}

/** Resultado de la resolución de sesión POST /api/session */
export interface SessionResponse {
  uuid: string;
  alias: string;
  email: string | null;
  phone: string | null;
  isNew: boolean;
  conflict?: boolean;
  storedUuid?: string;
  storedAlias?: string;
}
