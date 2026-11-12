// Moved to @simple-agent-manager/worker-core (worker modularization W0). This re-export keeps
// existing importers unchanged; new code imports from the package entry point directly.
export {
  DEFAULT_SEARCH_QUERY_MAX_LENGTH,
  DEFAULT_SEARCH_QUERY_MAX_TERM_LENGTH,
  DEFAULT_SEARCH_QUERY_MAX_TERMS,
  escapeSearchQueryForLike,
  getSearchQueryLikePatterns,
  getSearchQueryTerms,
  MAX_SEARCH_QUERY_MAX_TERM_LENGTH,
  MIN_SEARCH_QUERY_MAX_LENGTH,
  MIN_SEARCH_QUERY_MAX_TERM_LENGTH,
  MIN_SEARCH_QUERY_MAX_TERMS,
  type NormalizedSearchQuery,
  normalizeSearchQuery,
  normalizeSearchQueryWithLimits,
  resolveSearchQueryLimits,
  type SearchQueryLimitEnv,
  type SearchQueryLimits,
} from '@simple-agent-manager/worker-core';
