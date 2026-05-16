import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
  expectJsonRecord,
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
