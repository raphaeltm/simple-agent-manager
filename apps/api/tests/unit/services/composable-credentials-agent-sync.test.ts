import { describe, expect, it, vi } from 'vitest';

import { syncAgentCredentialToCC } from '../../../src/services/composable-credentials/agent-sync';

function makeRecordingD1Database() {
  const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
  const database = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...bindings: unknown[]) => {
        prepared.push({ sql, bindings });
        return { run: vi.fn() };
      }),
    })),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as D1Database;

  return { database, prepared };
}

function findConfigurationInsert(prepared: Array<{ sql: string; bindings: unknown[] }>) {
  return prepared.find((entry) => entry.sql.includes('INSERT INTO cc_configurations'));
}

describe('syncAgentCredentialToCC', () => {
  it('stores OpenCode Zen settings when syncing an OpenCode API key', async () => {
    const { database, prepared } = makeRecordingD1Database();

    await syncAgentCredentialToCC(database, {
      userId: 'user-1',
      agentType: 'opencode',
      credentialKind: 'api-key',
      encryptedToken: 'encrypted-token',
      iv: 'iv',
      agentName: 'OpenCode',
      isActive: true,
    });

    const configurationInsert = findConfigurationInsert(prepared);

    expect(configurationInsert).toBeDefined();
    expect(configurationInsert?.bindings[5]).toBe(
      JSON.stringify({
        providerId: 'opencode-zen',
        model: 'opencode/claude-sonnet-4-6',
      })
    );
    expect(database.batch).toHaveBeenCalledTimes(1);
  });

  it('leaves non-OpenCode configuration settings empty', async () => {
    const { database, prepared } = makeRecordingD1Database();

    await syncAgentCredentialToCC(database, {
      userId: 'user-1',
      agentType: 'claude-code',
      credentialKind: 'api-key',
      encryptedToken: 'encrypted-token',
      iv: 'iv',
      agentName: 'Claude Code',
      isActive: true,
    });

    const configurationInsert = findConfigurationInsert(prepared);

    expect(configurationInsert?.bindings[5]).toBeNull();
  });
});
