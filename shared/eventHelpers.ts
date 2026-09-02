/**
 * shared/eventHelpers.ts
 *
 * Helper functions for event and role calculations.
 * Used by backend to compute effective availability and role cascades.
 */

export interface EffectiveAvailability {
  effectiveAvailableFrom: Date;
  hoursOfAdvance: number;
  bonusHours: number;
  totalAdvanceHours: number;
}

export interface RoleHierarchy {
  [key: string]: number;
}

/**
 * Role hierarchy levels (lower = higher privilege)
 * familiares (1) > amigos (2) > conocidos (3) > publico (4)
 */
export const ROLE_HIERARCHY: RoleHierarchy = {
  familiares: 1,
  amigos: 2,
  conocidos: 3,
  publico: 4
};

export const VALID_ROLES = Object.keys(ROLE_HIERARCHY);

/**
 * Event lifecycle states (final set):
 * draft -> scheduled (published) -> active (available_from) ->
 * closing (claims_close_at) -> closed (pickup_deadline).
 */
export const EVENT_STATUSES = ['draft', 'scheduled', 'active', 'closing', 'closed'] as const;

/**
 * Per-role pickup window column name on `events` for a given role.
 * Example: resolvePickupHoursField('amigos') -> 'amigos_pickup_hours'
 */
export function resolvePickupHoursField(role: string): string | null {
  const field = {
    familiares: 'familiares_pickup_hours',
    amigos: 'amigos_pickup_hours',
    conocidos: 'conocidos_pickup_hours',
    publico: 'publico_pickup_hours'
  } as const;
  return (field as Record<string, string>)[role] ?? null;
}

/**
 * Single source of truth for a user's role within an event context.
 * Priority: membership role in that event, then the GLOBAL role as fallback
 * (a global friend sees friend-level items in any event even without an
 * invitation). Resolves the "visibility vs membership" inconsistency: the same
 * role is used for visibility, price and availability.
 */
export function resolveEffectiveRole(
  membershipRole: string | null | undefined,
  globalRole: string | null | undefined
): string {
  return membershipRole || globalRole || 'publico';
}

/**
 * Calculate effective availability for a user in an event
 * considering their role's advance_hours + bonus_hours from referrals
 */
export async function calculateEffectiveAvailability(
  userUuid: string,
  eventId: string,
  dbPool: any
): Promise<EffectiveAvailability> {
  const result = await dbPool.query(
    `SELECT 
       e.available_from,
       COALESCE(em.role, 'publico') as user_role,
       COALESCE(em.bonus_hours, 0) as bonus_hours,
       CASE 
         WHEN COALESCE(em.role, 'publico') = 'familiares' THEN e.familiares_advance_hours
         WHEN COALESCE(em.role, 'publico') = 'amigos' THEN e.amigos_advance_hours
         WHEN COALESCE(em.role, 'publico') = 'conocidos' THEN e.conocidos_advance_hours
         ELSE 0
       END as role_advance_hours
     FROM events e
     LEFT JOIN event_members em ON e.id = em.event_id AND em.user_uuid = $1
     WHERE e.id = $2`,
    [userUuid, eventId]
  );

  if (result.rows.length === 0) {
    throw new Error('Event not found');
  }

  const {
    available_from: availableFrom,
    role_advance_hours: roleAdvanceHours,
    bonus_hours: bonusHours
  } = result.rows[0];

  const totalHoursAdvance = (roleAdvanceHours || 0) + (bonusHours || 0);
  const effectiveAvailableFrom = new Date(
    new Date(availableFrom).getTime() - totalHoursAdvance * 60 * 60 * 1000
  );

  return {
    effectiveAvailableFrom,
    hoursOfAdvance: roleAdvanceHours || 0,
    bonusHours: bonusHours || 0,
    totalAdvanceHours: totalHoursAdvance
  };
}

/**
 * Determine if a role upgrade should occur
 * Returns new role if invitation role has higher privilege, otherwise keeps current role
 */
export function determineRoleAfterInvitation(
  currentRole: string,
  invitationRole: string
): string {
  const currentLevel = ROLE_HIERARCHY[currentRole] || ROLE_HIERARCHY['publico'];
  const invitationLevel = ROLE_HIERARCHY[invitationRole] || ROLE_HIERARCHY['publico'];

  // Lower level = higher privilege, so upgrade if invitation has lower level
  return invitationLevel < currentLevel ? invitationRole : currentRole;
}

/**
 * Check if a user with a given role can see an item with visibility_level
 * visibility_level: 0=admin only, 1=familiares, 2=amigos, 3=conocidos, 4=publico
 */
export function canUserSeeItem(userRole: string, visibilityLevel: number): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] || ROLE_HIERARCHY['publico'];
  return userLevel <= visibilityLevel;
}

/**
 * Generate a cryptic invitation code (16 alphanumeric characters)
 */
export function generateInvitationCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Validate event dates
 */
export function validateEventDates(availableFrom: Date, pickupDeadline: Date): { valid: boolean; error?: string } {
  const now = new Date();

  if (new Date(availableFrom) <= now) {
    return { valid: false, error: 'available_from must be in the future' };
  }

  if (new Date(pickupDeadline) <= new Date(availableFrom)) {
    return { valid: false, error: 'pickup_deadline must be after available_from' };
  }

  return { valid: true };
}
