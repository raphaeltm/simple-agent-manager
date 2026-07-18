import { describe, expect, it } from 'vitest';

import {
  expectJsonRecord,
  readResponseJsonRecord,
  requireString,
} from '../../src/runtime-validation';

describe('runtime-validation boundary helpers', () => {
  it('rejects array payloads at object boundaries', async () => {
    await expect(
      readResponseJsonRecord(new Response(JSON.stringify([])), 'acp.messages')
    ).rejects.toThrow('Invalid payload at acp.messages: expected object');
  });

  it('rejects missing required string fields with context', () => {
    const payload = expectJsonRecord({ id: 123 }, 'acp.toolCall');

    expect(() => requireString(payload, 'id', 'acp.toolCall')).toThrow(
      'Invalid payload at acp.toolCall.id: expected string'
    );
  });
});
