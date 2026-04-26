// =============================================================================
// Policy Constants (Phase 4: Policy Propagation)
// All limits configurable via env vars (Constitution Principle XI)
// =============================================================================

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
}

export function resolvePolicyLimits(env: {
  POLICY_MAX_PER_PROJECT?: string;
  POLICY_TITLE_MAX_LENGTH?: string;
  POLICY_CONTENT_MAX_LENGTH?: string;
  POLICY_LIST_PAGE_SIZE?: string;
  POLICY_LIST_MAX_PAGE_SIZE?: string;
  POLICY_DEFAULT_CONFIDENCE?: string;
}): PolicyLimits {
  return {
    maxPerProject: Number(env.POLICY_MAX_PER_PROJECT) || DEFAULT_POLICY_MAX_PER_PROJECT,
    titleMaxLength: Number(env.POLICY_TITLE_MAX_LENGTH) || DEFAULT_POLICY_TITLE_MAX_LENGTH,
    contentMaxLength: Number(env.POLICY_CONTENT_MAX_LENGTH) || DEFAULT_POLICY_CONTENT_MAX_LENGTH,
    listPageSize: Number(env.POLICY_LIST_PAGE_SIZE) || DEFAULT_POLICY_LIST_PAGE_SIZE,
    listMaxPageSize: Number(env.POLICY_LIST_MAX_PAGE_SIZE) || DEFAULT_POLICY_LIST_MAX_PAGE_SIZE,
    defaultConfidence: Number(env.POLICY_DEFAULT_CONFIDENCE) || DEFAULT_POLICY_CONFIDENCE,
  };
}
