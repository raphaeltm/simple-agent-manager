import { parsePositiveInt } from './route-helpers';

export const DEFAULT_SEARCH_QUERY_MAX_LENGTH = 48;
export const DEFAULT_SEARCH_QUERY_MAX_TERMS = 12;
export const MIN_SEARCH_QUERY_MAX_LENGTH = 4;

export interface SearchQueryLimitEnv {
  SEARCH_QUERY_MAX_LENGTH?: string;
  SEARCH_QUERY_MAX_TERMS?: string;
}

export interface SearchQueryLimits {
  maxLength: number;
  maxTerms: number;
}

export interface NormalizedSearchQuery {
  query: string;
  queryTruncated: boolean;
  queryLimits: SearchQueryLimits;
}

export function resolveSearchQueryLimits(env: SearchQueryLimitEnv): SearchQueryLimits {
  return {
    // SQLite's deployed LIKE pattern ceiling is 50 bytes; the surrounding '%' wildcards use two.
    // Operators can lower this bound, but raising it would restore the 500 this guard prevents.
    maxLength: Math.max(
      MIN_SEARCH_QUERY_MAX_LENGTH,
      Math.min(
        parsePositiveInt(env.SEARCH_QUERY_MAX_LENGTH, DEFAULT_SEARCH_QUERY_MAX_LENGTH),
        DEFAULT_SEARCH_QUERY_MAX_LENGTH
      )
    ),
    maxTerms: parsePositiveInt(env.SEARCH_QUERY_MAX_TERMS, DEFAULT_SEARCH_QUERY_MAX_TERMS),
  };
}

const textEncoder = new TextEncoder();

function truncateLikeSafeUtf8(input: string, maxBytes: number): string {
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
 * Bound search work before input reaches FTS5 or LIKE. The UTF-8 byte budget includes the extra
 * escape byte needed by LIKE metacharacters, leaving two bytes for the surrounding '%' wildcards.
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
    maxLength: Math.max(
      MIN_SEARCH_QUERY_MAX_LENGTH,
      Math.min(queryLimits.maxLength, DEFAULT_SEARCH_QUERY_MAX_LENGTH)
    ),
    maxTerms: queryLimits.maxTerms,
  };
  const trimmed = input.trim();
  const lengthBounded = truncateLikeSafeUtf8(trimmed, effectiveLimits.maxLength).trimEnd();
  // Do not pass the env-controlled term limit to String.split(): values above 2^32 - 1
  // wrap to zero per ECMAScript and would turn a valid query into an empty string.
  const terms = lengthBounded ? lengthBounded.split(/\s+/) : [];
  const query = terms.slice(0, effectiveLimits.maxTerms).join(' ');

  return {
    query,
    queryTruncated: query !== trimmed,
    queryLimits: effectiveLimits,
  };
}

export function escapeSearchQueryForLike(query: string): string {
  return query.replace(/[%_\\]/g, '\\$&');
}
