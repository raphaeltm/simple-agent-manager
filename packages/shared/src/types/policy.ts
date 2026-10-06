// =============================================================================
// Project Policy Types (Phase 4: Policy Propagation)
// =============================================================================

/** Policy categories — what kind of policy this is. */
export const POLICY_CATEGORIES = ['rule', 'constraint', 'delegation', 'preference'] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

/** Policy sources — how this policy was created. */
export const POLICY_SOURCES = ['explicit', 'inferred'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

/**
 * Policy scopes — how long a policy is meant to apply.
 *
 * - `always`: a standing project policy. Injected into every session, forever.
 *   This is the default and matches the behavior of every policy created before
 *   lifecycle controls existed.
 * - `task`: a one-shot policy captured for a specific piece of work ("use profile
 *   X for the 2026-08-21 reliability wave"). A task-scoped policy MUST carry an
 *   `expiresAt` — that requirement is enforced at the write boundary and is the
 *   mechanism that stops one-shot constraints from silently becoming permanent.
 */
export const POLICY_SCOPES = ['always', 'task'] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

/** A project policy entry stored in ProjectData DO SQLite. */
export interface ProjectPolicy {
  id: string;
  category: PolicyCategory;
  title: string;
  content: string;
  source: PolicySource;
  sourceSessionId: string | null;
  confidence: number;
  active: boolean;
  /** How long this policy applies. Defaults to `always`. */
  scope: PolicyScope;
  /**
   * Epoch millis after which this policy stops being injected into sessions.
   * `null` means it never expires — the behavior of every pre-lifecycle policy.
   *
   * Expiry is evaluated at read time in `getActivePolicies`; an expired policy is
   * still `active`, still readable via `get_policy`, and still listed in the UI,
   * so a human can see why it stopped applying.
   */
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Request to create a new policy. */
export interface CreatePolicyRequest {
  category: PolicyCategory;
  title: string;
  content: string;
  source?: PolicySource;
  sourceSessionId?: string | null;
  confidence?: number;
  scope?: PolicyScope;
  expiresAt?: number | null;
}

/** Request to update an existing policy. */
export interface UpdatePolicyRequest {
  title?: string;
  content?: string;
  category?: PolicyCategory;
  active?: boolean;
  confidence?: number;
  scope?: PolicyScope;
  /** Pass `null` to clear an existing expiry (make the policy permanent). */
  expiresAt?: number | null;
}

/** Response from the list policies endpoint. */
export interface ListPoliciesResponse {
  policies: ProjectPolicy[];
  total: number;
}

/** Default values for policy configuration. */
export const POLICY_DEFAULTS = {
  maxPerProject: 100,
  titleMaxLength: 200,
  contentMaxLength: 2000,
  listPageSize: 50,
  listMaxPageSize: 200,
  defaultConfidence: 0.8,
} as const;

export function isPolicyCategory(value: string): value is PolicyCategory {
  return (POLICY_CATEGORIES as readonly string[]).includes(value);
}

export function isPolicySource(value: string): value is PolicySource {
  return (POLICY_SOURCES as readonly string[]).includes(value);
}

export function isPolicyScope(value: string): value is PolicyScope {
  return (POLICY_SCOPES as readonly string[]).includes(value);
}
