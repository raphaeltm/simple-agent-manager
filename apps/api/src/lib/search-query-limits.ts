import { parsePositiveInt } from './route-helpers';

export const DEFAULT_SEARCH_QUERY_MAX_LENGTH = 48;
export const DEFAULT_SEARCH_QUERY_MAX_TERMS = 12;

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
    maxLength: Math.min(
      parsePositiveInt(env.SEARCH_QUERY_MAX_LENGTH, DEFAULT_SEARCH_QUERY_MAX_LENGTH),
      DEFAULT_SEARCH_QUERY_MAX_LENGTH
    ),
    maxTerms: parsePositiveInt(env.SEARCH_QUERY_MAX_TERMS, DEFAULT_SEARCH_QUERY_MAX_TERMS),
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

/**
 * Bound search work before input reaches FTS5 or LIKE. The UTF-8 byte cap prevents a single giant
 * pattern and also bounds the work needed to apply the configured term cap.
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
    maxLength: Math.min(queryLimits.maxLength, DEFAULT_SEARCH_QUERY_MAX_LENGTH),
    maxTerms: queryLimits.maxTerms,
  };
  const trimmed = input.trim();
  const lengthBounded = truncateUtf8(trimmed, effectiveLimits.maxLength).trimEnd();
  const terms = lengthBounded ? lengthBounded.split(/\s+/, effectiveLimits.maxTerms + 1) : [];
  const query = terms.slice(0, effectiveLimits.maxTerms).join(' ');

  return {
    query,
    queryTruncated: query !== trimmed,
    queryLimits: effectiveLimits,
  };
}
