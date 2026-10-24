import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { AcpSessionActivityReportSchema } from '../../src/schemas/acp-sessions';

describe('AcpSessionActivityReportSchema', () => {
  it.each(['prompting', 'idle', 'recovering', 'error'] as const)('accepts %s activity', (activity) => {
    const result = v.safeParse(AcpSessionActivityReportSchema, {
      activity,
      nodeId: 'node-1',
    });

    expect(result.success).toBe(true);
  });

  it('rejects unknown activity', () => {
    const result = v.safeParse(AcpSessionActivityReportSchema, {
      activity: 'sleeping',
      nodeId: 'node-1',
    });

    expect(result.success).toBe(false);
  });
});
