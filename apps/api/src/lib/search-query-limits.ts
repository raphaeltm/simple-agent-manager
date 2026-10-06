import { parsePositiveInt } from './route-helpers';

export const DEFAULT_SEARCH_QUERY_MAX_LENGTH = 4096;
export const DEFAULT_SEARCH_QUERY_MAX_TERMS = 40;
export const DEFAULT_SEARCH_QUERY_MAX_TERM_LENGTH = 48;
export const MAX_SEARCH_QUERY_MAX_TERM_LENGTH = DEFAULT_SEARCH_QUERY_MAX_TERM_LENGTH;
export const MIN_SEARCH_QUERY_MAX_LENGTH = 4;
export const MIN_SEARCH_QUERY_MAX_TERMS = 1;
export const MIN_SEARCH_QUERY_MAX_TERM_LENGTH = 4;

export interface SearchQueryLimitEnv {
  SEARCH_QUERY_MAX_LENGTH?: string;
  SEARCH_QUERY_MAX_TERMS?: string;
  SEARCH_QUERY_MAX_TERM_LENGTH?: string;
}

export interface SearchQueryLimits {
  maxLength: number;
  maxTerms: number;
  maxTermLength: number;
}

export interface NormalizedSearchQuery {
  query: string;
  queryTruncated: boolean;
  queryLimits: SearchQueryLimits;
}

export function resolveSearchQueryLimits(env: SearchQueryLimitEnv): SearchQueryLimits {
  return {
    maxLength: Math.max(
      MIN_SEARCH_QUERY_MAX_LENGTH,
      parsePositiveInt(env.SEARCH_QUERY_MAX_LENGTH, DEFAULT_SEARCH_QUERY_MAX_LENGTH)
    ),
    // D1 allows 100 bound parameters per statement. Task and idea search use two fields per term
    // plus project/status/limit binds, so 40 terms leaves headroom on every shared search surface.
    maxTerms: Math.max(
      MIN_SEARCH_QUERY_MAX_TERMS,
      Math.min(
        parsePositiveInt(env.SEARCH_QUERY_MAX_TERMS, DEFAULT_SEARCH_QUERY_MAX_TERMS),
        DEFAULT_SEARCH_QUERY_MAX_TERMS
      )
    ),
    // SQLite's deployed LIKE pattern ceiling is 50 bytes; each per-term predicate reserves two
    // bytes for surrounding '%' wildcards, and LIKE escape bytes count toward this budget. Clamp
    // overrides to the safe ceiling so configuration cannot reintroduce pattern-complexity errors.
    maxTermLength: Math.min(
      Math.max(
        MIN_SEARCH_QUERY_MAX_TERM_LENGTH,
        parsePositiveInt(env.SEARCH_QUERY_MAX_TERM_LENGTH, DEFAULT_SEARCH_QUERY_MAX_TERM_LENGTH)
      ),
      MAX_SEARCH_QUERY_MAX_TERM_LENGTH
    ),
  };
}

const textEncoder = new TextEncoder();

function truncateUtf8(input: string, maxBytes: number): string {
  let byteLength = 0;
  let output = '';
  for (const character of input) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (byteLength + characterBytes > maxBytes) break;
    output += character;
    byteLength += characterBytes;
  }
  return output;
}

function truncateLikeSafeTerm(input: string, maxBytes: number): string {
  let byteLength = 0;
  let output = '';
  for (const character of input) {
    const escapeBytes = character === '%' || character === '_' || character === '\\' ? 1 : 0;
    const characterBytes = textEncoder.encode(character).byteLength + escapeBytes;
    if (byteLength + characterBytes > maxBytes) break;
    output += character;
    byteLength += characterBytes;
  }
  return output;
}

/**
 * Bound search work before input reaches FTS5 or LIKE. The total budget is a DoS guard; each
 * retained term also gets a LIKE-safe byte budget so search can AND short escaped patterns instead
 * of sending one long pattern to SQLite.
 */
export function normalizeSearchQuery(
  input: string,
  env: SearchQueryLimitEnv
): NormalizedSearchQuery {
  return normalizeSearchQueryWithLimits(input, resolveSearchQueryLimits(env));
}

export function normalizeSearchQueryWithLimits(
  input: string,
  queryLimits: SearchQueryLimits
): NormalizedSearchQuery {
  const effectiveLimits = {
    maxLength: Math.max(MIN_SEARCH_QUERY_MAX_LENGTH, queryLimits.maxLength),
    maxTerms: Math.max(
      MIN_SEARCH_QUERY_MAX_TERMS,
      Math.min(queryLimits.maxTerms, DEFAULT_SEARCH_QUERY_MAX_TERMS)
    ),
    maxTermLength: Math.min(
      Math.max(MIN_SEARCH_QUERY_MAX_TERM_LENGTH, queryLimits.maxTermLength),
      MAX_SEARCH_QUERY_MAX_TERM_LENGTH
    ),
  };
  const trimmed = input.trim();
  const lengthBounded = truncateUtf8(trimmed, effectiveLimits.maxLength).trimEnd();
  // Do not pass the env-controlled term limit to String.split(): values above 2^32 - 1
  // wrap to zero per ECMAScript and would turn a valid query into an empty string.
  const terms = lengthBounded ? lengthBounded.split(/\s+/) : [];
  const query = terms
    .slice(0, effectiveLimits.maxTerms)
    .map((term) => truncateLikeSafeTerm(term, effectiveLimits.maxTermLength))
    .filter(Boolean)
    .join(' ');

  return {
    query,
    queryTruncated: query !== trimmed,
    queryLimits: effectiveLimits,
  };
}

export function escapeSearchQueryForLike(query: string): string {
  return query.replace(/[%_\\]/g, String.raw`\$&`);
}

export function getSearchQueryTerms(query: string): string[] {
  return query.trim() ? query.trim().split(/\s+/) : [];
}

export function getSearchQueryLikePatterns(query: string): string[] {
  return getSearchQueryTerms(query).map((term) => `%${escapeSearchQueryForLike(term)}%`);
}
