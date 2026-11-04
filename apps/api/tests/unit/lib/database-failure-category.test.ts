import { describe, expect, it } from 'vitest';

import { databaseFailureCategory } from '../../../src/lib/database-failure-category';

describe('safe database failure categories', () => {
  it.each([
    ['SQLITE_BUSY: locked', 'busy'],
    ['SQLITE_CONSTRAINT: sensitive value', 'constraint'],
    ['SQLITE_FULL', 'storage_full'],
    ['SQLITE_TOOBIG', 'too_large'],
    ['SQLITE_CORRUPT', 'corrupt'],
    ['no such column: private_column', 'schema'],
    ['D1_TYPE_ERROR: private value', 'type'],
    ['D1_ERROR: overloaded', 'overloaded'],
    ['D1 request timed out', 'timeout'],
    ['D1_ERROR: internal error', 'unavailable'],
    ['unexpected private details', 'unknown'],
  ])('maps %s to an allowlisted category', (message, expected) => {
    const wrapper = Object.assign(
      new Error('Failed query: private SQL and params', {
        cause: new Error(message),
      }),
      { query: 'private SQL', params: ['private-identifier'] }
    );
    expect(databaseFailureCategory(wrapper)).toBe(expected);
  });

  it('does not infer a cause from SQL parameters, non-errors, or cycles', () => {
    const error = Object.assign(new Error('Failed query: params: SQLITE_BUSY'), { query: 'SQL' });
    error.cause = error;
    expect(databaseFailureCategory(error)).toBe('unknown');
    expect(databaseFailureCategory({ message: 'SQLITE_BUSY' })).toBe('unknown');
  });
});
