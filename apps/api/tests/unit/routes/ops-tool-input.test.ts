/**
 * Input checks shared by the Operations tools: times outside the Date range are caller errors,
 * and the Worker-log query rejects script names Admin → Logs would reject.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSetting: vi.fn().mockResolvedValue(1_000),
}));
vi.mock('../../../src/services/observability-logs', () => ({
  queryCloudflareLogs: vi.fn().mockResolvedValue({ logs: [], cursor: null, hasMore: false }),
}));

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { OpsToolInputError, optionalTime } from '../../../src/routes/mcp/ops-tool-runner';
import { queryCloudflareLogs } from '../../../src/services/observability-logs';
import { queryWorkerLogs } from '../../../src/services/worker-log-query';

describe('optionalTime', () => {
  it('accepts ISO times and epoch milliseconds inside the Date range', () => {
    expect(optionalTime({ t: '2026-11-03T12:00:00Z' }, 't')).toBe(
      Date.parse('2026-11-03T12:00:00Z')
    );
    expect(optionalTime({ t: 8.64e15 }, 't')).toBe(8.64e15);
    expect(optionalTime({}, 't')).toBeUndefined();
  });

  it('rejects numbers outside the Date range as a caller error, not a RangeError later', () => {
    expect(() => optionalTime({ t: 9_000_000_000_000_000 }, 't')).toThrow(OpsToolInputError);
    expect(() => optionalTime({ t: -9_000_000_000_000_000 }, 't')).toThrow(OpsToolInputError);
    expect(() => optionalTime({ t: 'not a time' }, 't')).toThrow(OpsToolInputError);
  });
});

describe('queryWorkerLogs scriptName', () => {
  const env = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' } as unknown as Env;
  const query = (scriptName: string) =>
    queryWorkerLogs(env, {
      timeRange: { start: '2026-11-03T11:00:00Z', end: '2026-11-03T12:00:00Z' },
      scriptName,
    });

  it('rejects a name outside the safe pattern before calling Cloudflare', async () => {
    await expect(query('sam-api"; drop')).rejects.toBeInstanceOf(AppError);
    expect(queryCloudflareLogs).not.toHaveBeenCalled();
  });

  it('passes a safe name through', async () => {
    await query('sam-api-staging');
    expect(queryCloudflareLogs).toHaveBeenCalledWith(
      expect.objectContaining({ scriptName: 'sam-api-staging' })
    );
  });
});
