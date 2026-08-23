// =============================================================================
// Policy Constants (Phase 4: Policy Propagation)
// All limits configurable via env vars (Constitution Principle XI)
// =============================================================================
import { POLICY_SCOPES } from '../types/policy';

/** Default max policies per project. Override via POLICY_MAX_PER_PROJECT env var. */
export const DEFAULT_POLICY_MAX_PER_PROJECT = 100;

/** Default max length for policy title. Override via POLICY_TITLE_MAX_LENGTH env var. */
export const DEFAULT_POLICY_TITLE_MAX_LENGTH = 200;

/** Default max length for policy content. Override via POLICY_CONTENT_MAX_LENGTH env var. */
export const DEFAULT_POLICY_CONTENT_MAX_LENGTH = 2000;

/** Default page size for policy list queries. Override via POLICY_LIST_PAGE_SIZE env var. */
export const DEFAULT_POLICY_LIST_PAGE_SIZE = 50;

/** Maximum page size for policy list queries. Override via POLICY_LIST_MAX_PAGE_SIZE env var. */
export const DEFAULT_POLICY_LIST_MAX_PAGE_SIZE = 200;

/** Default confidence for new policies. Override via POLICY_DEFAULT_CONFIDENCE env var. */
export const DEFAULT_POLICY_CONFIDENCE = 0.8;

/**
 * Default maximum horizon for a policy expiry, in milliseconds (365 days).
 * Bounds how far into the future `expiresAt` may be set, so a one-shot policy
 * cannot be given a nonsense expiry that makes it permanent in practice.
 * Override via POLICY_MAX_EXPIRY_MS env var.
 */
export const DEFAULT_POLICY_MAX_EXPIRY_MS = 365 * 24 * 60 * 60 * 1000;

// =============================================================================
// Resolved Limits (threaded from env → service layer → DO pure functions)
// =============================================================================

export interface PolicyLimits {
  maxPerProject: number;
  titleMaxLength: number;
  contentMaxLength: number;
  listPageSize: number;
  listMaxPageSize: number;
  defaultConfidence: number;
  maxExpiryMs: number;
}

export function resolvePolicyLimits(env: {
  POLICY_MAX_PER_PROJECT?: string;
  POLICY_TITLE_MAX_LENGTH?: string;
  POLICY_CONTENT_MAX_LENGTH?: string;
  POLICY_LIST_PAGE_SIZE?: string;
  POLICY_LIST_MAX_PAGE_SIZE?: string;
  POLICY_DEFAULT_CONFIDENCE?: string;
  POLICY_MAX_EXPIRY_MS?: string;
}): PolicyLimits {
  return {
    maxPerProject: Number(env.POLICY_MAX_PER_PROJECT) || DEFAULT_POLICY_MAX_PER_PROJECT,
    titleMaxLength: Number(env.POLICY_TITLE_MAX_LENGTH) || DEFAULT_POLICY_TITLE_MAX_LENGTH,
    contentMaxLength: Number(env.POLICY_CONTENT_MAX_LENGTH) || DEFAULT_POLICY_CONTENT_MAX_LENGTH,
    listPageSize: Number(env.POLICY_LIST_PAGE_SIZE) || DEFAULT_POLICY_LIST_PAGE_SIZE,
    listMaxPageSize: Number(env.POLICY_LIST_MAX_PAGE_SIZE) || DEFAULT_POLICY_LIST_MAX_PAGE_SIZE,
    defaultConfidence: Number(env.POLICY_DEFAULT_CONFIDENCE) || DEFAULT_POLICY_CONFIDENCE,
    maxExpiryMs: Number(env.POLICY_MAX_EXPIRY_MS) || DEFAULT_POLICY_MAX_EXPIRY_MS,
  };
}

// =============================================================================
// Policy lifecycle write-boundary validation
// =============================================================================

/**
 * Validate the `scope` / `expiresAt` pair for a policy write.
 *
 * This is the ONE implementation of the rule, shared by the MCP tool handlers
 * (`routes/mcp/policy-tools.ts`) and the REST routes (`routes/policies.ts`), so
 * the two boundaries cannot drift apart (rules 24 / 59).
 *
 * The load-bearing invariant is that a `task`-scoped policy must have an expiry.
 * Without it, an agent capturing a one-shot workflow constraint would produce a
 * policy that is indistinguishable from a standing one and would be injected
 * into every future session forever — the exact failure this feature exists to
 * prevent.
 *
 * `expiresAt: null` is always valid: it means "never expires", and on an update
 * it clears an existing expiry.
 *
 * @returns an error message describing the first problem found, or `null` when valid.
 */
export function validatePolicyLifecycle(input: {
  /** Effective scope after the write (existing value merged with the update). */
  scope: string;
  /** Effective expiry after the write, or `null`/`undefined` for none. */
  expiresAt: number | null | undefined;
  now: number;
  maxExpiryMs: number;
}): string | null {
  const { scope, expiresAt, now, maxExpiryMs } = input;

  if (!(POLICY_SCOPES as readonly string[]).includes(scope)) {
    return `scope must be one of: ${POLICY_SCOPES.join(', ')}`;
  }

  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return 'expiresAt must be a number (epoch milliseconds) or null';
    }
    if (!Number.isInteger(expiresAt)) {
      return 'expiresAt must be an integer number of epoch milliseconds';
    }
    if (expiresAt <= now) {
      return 'expiresAt must be in the future — use remove_policy to deactivate a policy immediately';
    }
    if (expiresAt > now + maxExpiryMs) {
      return `expiresAt must be within ${maxExpiryMs}ms of now`;
    }
  }

  if (scope === 'task' && (expiresAt === null || expiresAt === undefined)) {
    return "a task-scoped policy must set expiresAt so it cannot outlive the work it was captured for (use scope 'always' for a standing policy)";
  }

  return null;
}
