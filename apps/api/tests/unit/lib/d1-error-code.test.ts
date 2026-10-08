import { describe, expect, it } from 'vitest';

import { d1CauseCode } from '../../../src/lib/d1-error-code';
import { serializeError } from '../../../src/lib/logger';

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
    expect(d1CauseCode(new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)')))
      .toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
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
