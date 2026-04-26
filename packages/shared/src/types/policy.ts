// =============================================================================
// Project Policy Types (Phase 4: Policy Propagation)
// =============================================================================

/** Policy categories — what kind of policy this is. */
export const POLICY_CATEGORIES = ['rule', 'constraint', 'delegation', 'preference'] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

/** Policy sources — how this policy was created. */
export const POLICY_SOURCES = ['explicit', 'inferred'] as const;
export type PolicySource = (typeof POLICY_SOURCES)[number];

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
}

/** Request to update an existing policy. */
export interface UpdatePolicyRequest {
  title?: string;
  content?: string;
  category?: PolicyCategory;
  active?: boolean;
  confidence?: number;
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
