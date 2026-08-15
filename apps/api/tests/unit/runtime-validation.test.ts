import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  expectJsonRecord,
  maybeJsonRecord,
  parseJsonRecord,
  readRequestJsonRecord,
  readResponseJson,
  RuntimeValidationError,
} from '../../src/lib/runtime-validation';

describe('runtime-validation helpers', () => {
  it('rejects non-object JSON records', () => {
    expect(() => expectJsonRecord([], 'unit.array')).toThrow(RuntimeValidationError);
    expect(() => parseJsonRecord('"not-object"', 'unit.string')).toThrow(RuntimeValidationError);
  });

  it('pins the maybeJsonRecord/expectJsonRecord array-handling divergence', () => {
    // maybeJsonRecord: valibot's record() schema treats arrays as objects
    // with numeric string keys, so an array is ACCEPTED and coerced.
    expect(maybeJsonRecord(['a', 'b'])).toEqual({ '0': 'a', '1': 'b' });
    expect(maybeJsonRecord([])).toEqual({});
    // expectJsonRecord explicitly rejects arrays before schema parsing.
    expect(() => expectJsonRecord(['a', 'b'], 'unit.array-divergence')).toThrow(
      RuntimeValidationError
    );
    // Both agree on a genuine non-array record.
    expect(maybeJsonRecord({ a: 1 })).toEqual({ a: 1 });
    expect(expectJsonRecord({ a: 1 }, 'unit.record')).toEqual({ a: 1 });
    // Both agree null/undefined are not records.
    expect(maybeJsonRecord(null)).toBeNull();
    expect(maybeJsonRecord(undefined)).toBeNull();
  });

  it('validates request JSON bodies at runtime', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'proj_123' }),
    });

    await expect(readRequestJsonRecord(request, 'unit.request')).resolves.toEqual({
      projectId: 'proj_123',
    });
  });

  it('rejects malformed response JSON against a schema', async () => {
    const response = new Response(JSON.stringify({ access_token: 123 }));
    const schema = v.object({ access_token: v.string() });

    await expect(readResponseJson(response, schema, 'unit.response')).rejects.toThrow(
      RuntimeValidationError
    );
  });
});
