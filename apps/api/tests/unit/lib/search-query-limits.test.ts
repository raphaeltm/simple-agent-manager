import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SEARCH_QUERY_MAX_LENGTH,
  DEFAULT_SEARCH_QUERY_MAX_TERMS,
  normalizeSearchQuery,
} from '../../../src/lib/search-query-limits';

describe('search query limits', () => {
  it('preserves a normal query and reports the defaults', () => {
    expect(normalizeSearchQuery('  archive search reliability  ', {})).toEqual({
      query: 'archive search reliability',
      queryTruncated: false,
      queryLimits: {
        maxLength: DEFAULT_SEARCH_QUERY_MAX_LENGTH,
        maxTerms: DEFAULT_SEARCH_QUERY_MAX_TERMS,
      },
    });
  });

  it('enforces env-overridden term and UTF-8 byte limits', () => {
    expect(
      normalizeSearchQuery('alpha beta gamma delta', {
        SEARCH_QUERY_MAX_LENGTH: '8',
        SEARCH_QUERY_MAX_TERMS: '3',
      })
    ).toEqual({
      query: 'alpha be',
      queryTruncated: true,
      queryLimits: { maxLength: 8, maxTerms: 3 },
    });

    expect(
      normalizeSearchQuery('😀😀😀', {
        SEARCH_QUERY_MAX_LENGTH: '8',
        SEARCH_QUERY_MAX_TERMS: '3',
      }).query
    ).toBe('😀😀');

    expect(
      normalizeSearchQuery('alpha beta gamma', {
        SEARCH_QUERY_MAX_LENGTH: '100',
        SEARCH_QUERY_MAX_TERMS: '100',
      })
    ).toEqual({
      query: 'alpha beta gamma',
      queryTruncated: false,
      queryLimits: {
        maxLength: DEFAULT_SEARCH_QUERY_MAX_LENGTH,
        maxTerms: 100,
      },
    });
  });
});
