import { describe, expect, it } from 'vitest';

import { d1CauseCode, d1ErrorCategory } from '../../src/d1-error-code';
import { serializeError } from '../../src/logger';

describe('allowlisted D1 cause diagnostics', () => {
  it.each(['SQLITE_CONSTRAINT', 'SQLITE_NOMEM', 'SQLITE_BUSY', 'SQLITE_CONSTRAINT_FOREIGNKEY'])(
    'preserves %s without cause text',
    (code) => {
      const error = new Error('Failed query: select private\nparams: private', {
        cause: new Error(`D1_ERROR: arbitrary-private-detail: ${code}`),
      });
      expect(d1CauseCode(error)).toBe(code);
      expect(serializeError(error)).toMatchObject({ causeCode: code });
      expect(JSON.stringify(serializeError(error))).not.toContain('private');
    }
  );
  it('recognizes the extended code suffix emitted by D1', () => {
    expect(
      d1CauseCode(
        new Error(
          'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)'
        )
      )
    ).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });
  it('omits unknown codes and ignores code-like SQL parameters', () => {
    expect(d1CauseCode(new Error('Failed query: select ?\nparams: SQLITE_NOMEM'))).toBeUndefined();
    expect(d1CauseCode(new Error('private: SQLITE_PRIVATE'))).toBeUndefined();
    expect(
      d1CauseCode(Object.assign(new Error('private'), { code: 'private-code' }))
    ).toBeUndefined();
  });
  it('bounds cyclic causes and traverses nested wrappers', () => {
    const cycle = new Error('wrapper');
    cycle.cause = cycle;
    expect(d1CauseCode(cycle)).toBeUndefined();
    expect(d1CauseCode(new Error('wrapper', { cause: new Error('D1_ERROR: private') }))).toBe(
      'D1_ERROR'
    );
  });
});

describe('safe D1 failure categories', () => {
  it.each([
    ['D1_ERROR: too many SQL variables: SQLITE_ERROR', 'd1_too_many_variables'],
    ['D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR', 'd1_like_pattern_too_complex'],
    ['D1_ERROR: UNIQUE constraint failed: private.secret: SQLITE_CONSTRAINT', 'constraint_unique'],
    [
      'D1_ERROR: NOT NULL constraint failed: private.secret: SQLITE_CONSTRAINT',
      'constraint_notnull',
    ],
    ['D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 'constraint_foreignkey'],
    ['D1_ERROR: CHECK constraint failed: private_secret: SQLITE_CONSTRAINT', 'constraint_check'],
    ['D1_ERROR: no such table: private_secret: SQLITE_ERROR', 'no_such_table'],
    ['D1_ERROR: no such column: private_secret: SQLITE_ERROR', 'no_such_column'],
    ['D1_ERROR: table private has no column named secret: SQLITE_ERROR', 'no_such_column'],
    ['D1_ERROR: not authorized: SQLITE_AUTH', 'sqlite_auth'],
    ['D1_ERROR: not authorized: SQLITE_ERROR', 'sqlite_auth'],
    ['D1_ERROR: not authorized', 'sqlite_auth'],
    ['D1_ERROR: storage operation exceeded its timeout and reset the object', 'd1_transient'],
    ['D1_ERROR: request overloaded: SQLITE_ERROR', 'd1_transient'],
    ['D1_ERROR: Network connection lost.', 'd1_transient'],
    ['D1_ERROR: D1 DB is overloaded. Too many requests queued.', 'd1_transient'],
    [
      'D1_ERROR: D1 DB storage operation exceeded timeout which caused object to be reset.',
      'd1_transient',
    ],
    ['database is locked: SQLITE_BUSY', 'd1_transient'],
    ['D1_ERROR: unknown private error', 'other'],
    ['D1_ERROR: no such table: UNIQUE constraint failed: SQLITE_ERROR', 'no_such_table'],
    ['D1_ERROR: syntax error near "not authorized": SQLITE_ERROR', 'other'],
  ])('maps %s to only %s', (message, category) => {
    expect(d1ErrorCategory(new Error(message))).toBe(category);
  });

  it('never interprets Drizzle SQL or parameters as the driver failure category', () => {
    const outer = new Error(
      'Failed query: SELECT ?\nparams: D1_ERROR: too many SQL variables: SQLITE_ERROR',
      {
        cause: new Error('D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR'),
      }
    );
    expect(d1ErrorCategory(outer)).toBe('d1_like_pattern_too_complex');
    expect(d1ErrorCategory(new Error(outer.message))).toBeUndefined();
  });

  it('handles native code properties, ordinary errors, and cyclic causes safely', () => {
    expect(
      d1ErrorCategory(Object.assign(new Error('private'), { code: 'SQLITE_CONSTRAINT_NOTNULL' }))
    ).toBe('constraint_notnull');
    expect(d1ErrorCategory(new Error('UNIQUE constraint failed: private.secret'))).toBeUndefined();
    const cycle = new Error('D1_ERROR: private');
    cycle.cause = cycle;
    expect(d1ErrorCategory(cycle)).toBe('other');
  });
});
