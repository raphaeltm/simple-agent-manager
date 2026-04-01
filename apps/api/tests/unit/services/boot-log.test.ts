import type { BootLogEntry } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import { appendBootLog, getBootLogs, writeBootLogs } from '../../../src/services/boot-log';

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => {
      const val = store.get(key);
      return val ? JSON.parse(val) : null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeEntry(step: string, status: BootLogEntry['status'], message: string): BootLogEntry {
  return { step, status, message, timestamp: new Date().toISOString() };
}

describe('boot-log service', () => {
  it('getBootLogs returns empty array when no logs exist', async () => {
    const kv = createMockKV();
    const logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toEqual([]);
  });

  it('appendBootLog adds entries and getBootLogs retrieves them', async () => {
    const kv = createMockKV();
    await appendBootLog(kv, 'ws-1', makeEntry('volume', 'completed', 'Volume ready'));
    await appendBootLog(kv, 'ws-1', makeEntry('clone', 'started', 'Cloning repo'));

    const logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toHaveLength(2);
    expect(logs[0].step).toBe('volume');
    expect(logs[1].step).toBe('clone');
  });

  it('writeBootLogs with empty array clears all logs', async () => {
    const kv = createMockKV();
    // Add some logs first
    await appendBootLog(kv, 'ws-1', makeEntry('volume', 'completed', 'Volume ready'));
    await appendBootLog(kv, 'ws-1', makeEntry('clone', 'failed', 'Clone failed'));

    // Verify logs exist
    let logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toHaveLength(2);

    // Clear logs
    await writeBootLogs(kv, 'ws-1', []);

    // Verify logs are cleared
    logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toEqual([]);
  });

  it('writeBootLogs overwrites existing logs', async () => {
    const kv = createMockKV();
    await appendBootLog(kv, 'ws-1', makeEntry('old-step', 'failed', 'Old failure'));

    const newLogs = [makeEntry('new-step', 'started', 'Fresh start')];
    await writeBootLogs(kv, 'ws-1', newLogs);

    const logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].step).toBe('new-step');
  });

  it('logs for different workspaces are isolated', async () => {
    const kv = createMockKV();
    await appendBootLog(kv, 'ws-1', makeEntry('volume', 'completed', 'Volume ready'));
    await appendBootLog(kv, 'ws-2', makeEntry('clone', 'started', 'Cloning'));

    // Clearing ws-1 should not affect ws-2
    await writeBootLogs(kv, 'ws-1', []);

    expect(await getBootLogs(kv, 'ws-1')).toEqual([]);
    const ws2Logs = await getBootLogs(kv, 'ws-2');
    expect(ws2Logs).toHaveLength(1);
    expect(ws2Logs[0].step).toBe('clone');
  });

  it('clearing and re-appending simulates restart flow', async () => {
    const kv = createMockKV();
    // First provisioning attempt fails
    await appendBootLog(kv, 'ws-1', makeEntry('volume', 'completed', 'Volume ready'));
    await appendBootLog(kv, 'ws-1', makeEntry('clone', 'failed', 'Clone failed'));
    expect(await getBootLogs(kv, 'ws-1')).toHaveLength(2);

    // Restart: clear logs, then new provisioning appends fresh ones
    await writeBootLogs(kv, 'ws-1', []);
    expect(await getBootLogs(kv, 'ws-1')).toEqual([]);

    await appendBootLog(kv, 'ws-1', makeEntry('volume', 'completed', 'Volume ready'));
    const logs = await getBootLogs(kv, 'ws-1');
    expect(logs).toHaveLength(1);
    expect(logs[0].step).toBe('volume');
    expect(logs[0].status).toBe('completed');
  });
});
