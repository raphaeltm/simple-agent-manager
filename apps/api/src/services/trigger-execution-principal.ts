/**
 * Trigger execution principal — who a trigger actually runs as.
 *
 * `triggers.user_id` records who CREATED the trigger. `triggers.execution_user_id`
 * records the principal an offboarding keep-active transfer authorized, and it is
 * the value the runtime actually executes with. `submitTriggeredTask` re-checks
 * `task:write` on that principal at execution time, so a trigger whose principal
 * is no longer an authorized member fails closed at its next fire.
 *
 * Anything that reasons about "whose access does this trigger consume" must use
 * the effective executor, not the creator. Offboarding inventory previously used
 * the creator, so a trigger transferred A -> B was invisible when B was
 * offboarded: B could be removed while the trigger still ran as B.
 */
import type * as schema from '../db/schema';
import { type ProjectCapability, projectRoleHasCapability } from '../middleware/project-auth';

/**
 * Capability a trigger execution principal must currently hold. Must stay equal
 * to the capability `submitTriggeredTask` requires, or offboarding can authorize
 * a principal whose next actual execution fails.
 */
export const TRIGGER_EXECUTION_CAPABILITY: ProjectCapability = 'task:write';

/** Descending preference; a principal must also hold TRIGGER_EXECUTION_CAPABILITY. */
const ROLE_PREFERENCE: readonly string[] = ['owner', 'admin', 'maintainer', 'viewer'];

/** The principal a trigger actually executes as. */
export function resolveTriggerExecutionUserId(
  trigger: Pick<schema.TriggerRow, 'executionUserId' | 'userId'>
): string {
  return trigger.executionUserId ?? trigger.userId;
}

export interface TriggerExecutionPrincipalCandidate {
  userId: string;
  role: string;
  status: string;
}

/**
 * Members who may serve as a trigger execution principal after `departingUserId`
 * leaves: active, currently capable, and not the departing member.
 *
 * Ordered deterministically (role preference, then userId) so preview and apply
 * agree and repeated calls are reproducible.
 */
export function authorizedRemainingExecutionPrincipals(
  members: readonly TriggerExecutionPrincipalCandidate[],
  departingUserId: string
): TriggerExecutionPrincipalCandidate[] {
  return members
    .filter(
      (member) =>
        member.userId !== departingUserId &&
        member.status === 'active' &&
        projectRoleHasCapability(member.role, TRIGGER_EXECUTION_CAPABILITY)
    )
    .sort((a, b) => {
      const rankA = ROLE_PREFERENCE.indexOf(a.role);
      const rankB = ROLE_PREFERENCE.indexOf(b.role);
      const normalizedA = rankA === -1 ? ROLE_PREFERENCE.length : rankA;
      const normalizedB = rankB === -1 ? ROLE_PREFERENCE.length : rankB;
      if (normalizedA !== normalizedB) return normalizedA - normalizedB;
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
    });
}

/**
 * Pick the principal a keep-active transfer should install.
 *
 * `preferredUserId` is the acting user: when they are themselves an authorized
 * remaining principal their explicit decision wins, which keeps the ordinary
 * (non-self) offboarding behaviour unchanged. Self-offboarding, or an actor who
 * has lost the capability, falls through to the deterministic ranking instead of
 * installing a principal that is about to be removed or is already unauthorized.
 *
 * Returns null when no remaining member can serve — callers MUST fail closed
 * rather than leave the departing member installed.
 */
export function selectTriggerExecutionPrincipal(input: {
  members: readonly TriggerExecutionPrincipalCandidate[];
  departingUserId: string;
  preferredUserId: string;
}): TriggerExecutionPrincipalCandidate | null {
  const candidates = authorizedRemainingExecutionPrincipals(input.members, input.departingUserId);
  return (
    candidates.find((candidate) => candidate.userId === input.preferredUserId) ??
    candidates[0] ??
    null
  );
}
