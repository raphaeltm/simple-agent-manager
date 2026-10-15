import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { checkMcpRateLimit } from '../../../src/routes/mcp/_helpers';
import { appendBootLog, getBootLogs, writeBootLogs } from '../../../src/services/boot-log';
import { storageCutover } from '../../../src/services/reliability-storage';

const entry = {
  step: 'clone',
  status: 'started' as const,
  message: 'Cloning',
  timestamp: '2026-10-15T00:00:00Z',
};
afterEach(() => vi.useRealTimers());

function fixture() {
  const kv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  } as unknown as KVNamespace;
  const stub = {
    consume: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    append: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    replace: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    read: vi.fn().mockRejectedValue(new Error('DO unavailable')),
  };
  const namespace = { idFromName: vi.fn((x) => x), get: vi.fn(() => stub) };
  const config = {
    MCP_RATE_COUNTER_CUTOVER_AT: '0',
    BOOT_LOG_STORAGE_CUTOVER_AT: '0',
    MCP_RATE_COUNTER: namespace,
    WORKSPACE_BOOT_LOG: namespace,
  } as unknown as Env;
  return { kv, stub, namespace, config };
}

describe('Reliability storage ownership', () => {
  it.each(['nope', '-1', '1.2', 'Infinity', '9007199254740992'])(
    'rejects invalid cutover %s',
    (value) => {
      expect(() => storageCutover(value)).toThrow();
    }
  );
  it('keeps absence as bridge mode and permits explicit clean-install activation', () => {
    expect(storageCutover(undefined)).toBeNull();
    expect(storageCutover('0')).toBe(0);
  });
  it('never falls back to KV when the authoritative counter fails', async () => {
    const { kv, config, namespace } = fixture();
    await expect(checkMcpRateLimit(kv, 'agent-fallback', config)).rejects.toThrow('DO unavailable');
    expect(namespace.idFromName).toHaveBeenCalledWith('agent-fallback');
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
  it('fails closed when binding is missing after activation', async () => {
    const { kv, config } = fixture();
    delete config.MCP_RATE_COUNTER;
    await expect(checkMcpRateLimit(kv, 'task', config)).rejects.toThrow('binding required');
    expect(kv.put).not.toHaveBeenCalled();
  });
  it('uses KV for the entire window before the first activated window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:10Z'));
    const { kv, config, stub } = fixture();
    config.MCP_RATE_COUNTER_CUTOVER_AT = String(Date.now() / 1000 - 1);
    await checkMcpRateLimit(kv, 'task', config);
    expect(stub.consume).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-15T00:01:00Z'));
    await expect(checkMcpRateLimit(kv, 'task', config)).rejects.toThrow('DO unavailable');
    expect(stub.consume).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
  it('never writes legacy logs when durable append/clear/read fails', async () => {
    const { kv, config } = fixture();
    await expect(appendBootLog(kv, 'workspace', entry, config)).rejects.toThrow('DO unavailable');
    await expect(writeBootLogs(kv, 'workspace', [], config)).rejects.toThrow('DO unavailable');
    await expect(getBootLogs(kv, 'workspace', config)).rejects.toThrow('DO unavailable');
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });
});
