import type { CapacityWorkloadRole } from '@simple-agent-manager/shared';
import { isCapacityWorkloadRole } from '@simple-agent-manager/shared';

/**
 * Single source of truth for capacity-pool workload-role identity and eligibility.
 *
 * Default-pool reconciliation used to materialize only `workspace` candidates while
 * deployment provisioning asks for `deployment`, so every deployment placement was
 * rejected by the role predicate in placement-resolver-capacity. Reconciliation now
 * materializes one coupled candidate row per role from the same provider-native
 * offering; this module owns the id derivation, editor visibility, and the shared
 * eligibility predicate so the reconciler and the final admission fence cannot drift
 * apart (.claude/rules/24, .claude/rules/59, .claude/rules/61).
 */

/** The role a user actually curates in the pool editor. Its id is the unsuffixed candidate id. */
export const PRIMARY_CAPACITY_WORKLOAD_ROLE = 'workspace' satisfies CapacityWorkloadRole;

/**
 * Roles materialized for every selectable offering. `workspace` MUST stay first: it owns the
 * base candidate id, so upgrades keep their existing rows and user status edits keep their target.
 */
export const CAPACITY_POOL_MATERIALIZED_WORKLOAD_ROLES = [
  'workspace',
  'deployment',
] as const satisfies readonly CapacityWorkloadRole[];

const ROLE_ID_SEPARATOR = '#role=';

/**
 * Derive the candidate row id for a role. The primary role keeps the base id unchanged so
 * existing installations are not re-keyed and legacy/explicit membership survives upgrade.
 */
export function capacityCandidateIdForRole(baseId: string, role: CapacityWorkloadRole): string {
  return role === PRIMARY_CAPACITY_WORKLOAD_ROLE ? baseId : `${baseId}${ROLE_ID_SEPARATOR}${role}`;
}

/** Inverse of {@link capacityCandidateIdForRole}: the primary-role id this candidate is coupled to. */
export function capacityCandidateBaseId(candidateId: string): string {
  const separatorIndex = candidateId.lastIndexOf(ROLE_ID_SEPARATOR);
  return separatorIndex === -1 ? candidateId : candidateId.slice(0, separatorIndex);
}

/**
 * Role encoded in a candidate id. Returns null when the suffix is present but is not a known
 * role, so a malformed id is never silently treated as the primary role.
 */
export function capacityCandidateRoleFromId(candidateId: string): CapacityWorkloadRole | null {
  const separatorIndex = candidateId.lastIndexOf(ROLE_ID_SEPARATOR);
  if (separatorIndex === -1) return PRIMARY_CAPACITY_WORKLOAD_ROLE;
  const suffix = candidateId.slice(separatorIndex + ROLE_ID_SEPARATOR.length);
  return isCapacityWorkloadRole(suffix) ? suffix : null;
}

/**
 * Non-primary roles are materialized for placement only. They are hidden from pool
 * editor/summary DTOs so a user curates one row per offering instead of one row per role.
 */
export function isEditorVisibleCapacityCandidateRole(role: string | null | undefined): boolean {
  return role === PRIMARY_CAPACITY_WORKLOAD_ROLE;
}

/**
 * The shared eligibility predicate. The final admission fence MUST use this rather than
 * assuming `workspace`, or deployment placement regresses to "no eligible candidate".
 */
export function capacityCandidateSatisfiesWorkloadRole(
  candidateRole: string | null | undefined,
  requestedRole: CapacityWorkloadRole
): boolean {
  return candidateRole === requestedRole;
}
