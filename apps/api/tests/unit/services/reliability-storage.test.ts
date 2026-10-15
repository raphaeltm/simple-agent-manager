import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { checkMcpRateLimit } from '../../../src/routes/mcp/_helpers';
import { appendBootLog, getBootLogs, writeBootLogs } from '../../../src/services/boot-log';
import { readStorageActivation } from '../../../src/services/reliability-storage';

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
    appendBridge: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    replaceBridge: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    readBridge: vi.fn().mockRejectedValue(new Error('DO unavailable')),
  };
  const namespace = { idFromName: vi.fn((x) => x), get: vi.fn(() => stub) };
  const activation = { publishedAt: 0, rateCutoverAt: 60, bootLogCutoverAt: 60, windowSeconds: 60 };
  const first = vi.fn(async () => ({ value: JSON.stringify(activation) }));
  const database = {
    withSession: vi.fn(() => ({ prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) })),
  };
  const config = {
    DATABASE: database,
    MCP_RATE_COUNTER_CUTOVER_AT: '0',
    BOOT_LOG_STORAGE_CUTOVER_AT: '0',
    MCP_RATE_COUNTER: namespace,
    WORKSPACE_BOOT_LOG: namespace,
  } as unknown as Env;
  return { kv, stub, namespace, config, activation, first, database };
}

describe('Reliability storage ownership', () => {
  it.each([
    null,
    {},
    { publishedAt: 60, rateCutoverAt: 60, bootLogCutoverAt: 60, windowSeconds: 60 },
    { publishedAt: 0, rateCutoverAt: 61, bootLogCutoverAt: 60, windowSeconds: 60 },
    { publishedAt: 0, rateCutoverAt: 60, bootLogCutoverAt: 60, windowSeconds: 0 },
  ])('rejects invalid shared activation %#', async (record) => {
    const { database, first } = fixture();
    first.mockResolvedValueOnce({ value: JSON.stringify(record) });
    await expect(readStorageActivation(database as unknown as D1Database)).rejects.toThrow();
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
    const { kv, config, stub, activation } = fixture();
    activation.rateCutoverAt = Date.now() / 1000 + 50;
    await checkMcpRateLimit(kv, 'task', config);
    expect(stub.consume).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-15T00:01:00Z'));
    await expect(checkMcpRateLimit(kv, 'task', config)).rejects.toThrow('DO unavailable');
    expect(stub.consume).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
  it('reads the shared primary on every call, including when previously unset', async () => {
    const { database, first } = fixture();
    first.mockResolvedValueOnce(null as never);
    expect(await readStorageActivation(database as unknown as D1Database)).toBeNull();
    expect(await readStorageActivation(database as unknown as D1Database)).not.toBeNull();
    expect(database.withSession).toHaveBeenNthCalledWith(1, 'first-primary');
    expect(first).toHaveBeenCalledTimes(2);
  });
  it('fails closed on shared configuration failure and window mismatch', async () => {
    const { kv, config, first, activation } = fixture();
    first.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(checkMcpRateLimit(kv, 'task', config)).rejects.toThrow('database unavailable');
    activation.windowSeconds = 30;
    await expect(checkMcpRateLimit(kv, 'task', config)).rejects.toThrow('window differs');
    expect(kv.put).not.toHaveBeenCalled();
  });
  it('pins a pre-activation window across a delayed shared configuration lookup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:10Z'));
    const { kv, config, first, activation, stub } = fixture();
    activation.rateCutoverAt = Date.now() / 1000 + 50;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.mockImplementationOnce(async () => {
      await held;
      return { value: JSON.stringify(activation) };
    });
    const request = checkMcpRateLimit(kv, 'task', config);
    vi.setSystemTime(new Date('2026-10-15T00:01:01Z'));
    release();
    await request;
    expect(stub.consume).not.toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringContaining(':1792022400'),
      expect.any(String),
      expect.anything()
    );
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
