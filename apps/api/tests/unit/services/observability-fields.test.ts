import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
}));

import { safeParseContext } from '../../../src/services/observability-fields';

describe('safeParseContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for a null context (no log — nothing to parse)', () => {
    expect(safeParseContext(null, 'row-1')).toBeNull();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('returns null for an empty-string context (no log — nothing to parse)', () => {
    expect(safeParseContext('', 'row-1')).toBeNull();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('parses a well-formed JSON object', () => {
    const result = safeParseContext(JSON.stringify({ nodeId: 'node-1', attempt: 2 }), 'row-1');
    expect(result).toEqual({ nodeId: 'node-1', attempt: 2 });
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('degrades to null and logs a skip for a JSON-syntax error', () => {
    const result = safeParseContext('{not valid json', 'row-bad-syntax');
    expect(result).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'observability.context_parse_skipped',
      expect.objectContaining({ rowId: 'row-bad-syntax' })
    );
  });

  // Regression: the docstring promises "bad context degrades to null", but
  // only JSON.parse throwing was ever caught. A syntactically valid JSON
  // value that isn't a record (string, number, boolean, literal null)
  // previously passed straight through via the blind
  // `JSON.parse(context) as Record<string, unknown>` cast.
  it.each([
    ['a JSON string', '"just a string"'],
    ['a JSON number', '42'],
    ['a JSON boolean', 'true'],
    ['the JSON literal null', 'null'],
  ])('degrades to null and logs a skip for %s', (_label, raw) => {
    const result = safeParseContext(raw, 'row-non-object');
    expect(result).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'observability.context_parse_skipped',
      expect.objectContaining({ rowId: 'row-non-object' })
    );
  });

  it('documents that a JSON array is coerced to a numeric-keyed record, not null', () => {
    // maybeJsonRecord() (apps/api/src/lib/runtime-validation.ts) validates
    // via v.record(), which does not special-case arrays the way
    // expectJsonRecord() does — an array is typeof 'object' and satisfies a
    // string-keyed record schema. This is a characteristic of the shared
    // helper this call site reuses, not a gap specific to safeParseContext;
    // callers reading named context fields (e.g. context.nodeId) still get
    // `undefined` for an array, same net effect as null for this call site.
    const result = safeParseContext('[1,2,3]', 'row-array');
    expect(result).toEqual({ 0: 1, 1: 2, 2: 3 });
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });
});
