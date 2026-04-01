import { beforeEach,describe, expect, it } from 'vitest';

import { getCachedCommands,saveCachedCommands } from '../../../src/durable-objects/project-data/commands';

/**
 * Minimal in-memory SQLite mock for testing cached commands.
 */
class MockSqlStorage {
  private rows: Array<{ agent_type: string; name: string; description: string; updated_at: number }> = [];

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    const normalized = query.trim().toUpperCase();

    if (normalized.startsWith('DELETE FROM CACHED_COMMANDS')) {
      const agentType = params[0] as string;
      this.rows = this.rows.filter((r) => r.agent_type !== agentType);
      return { toArray: () => [] };
    }

    if (normalized.startsWith('INSERT') && normalized.includes('CACHED_COMMANDS')) {
      this.rows.push({
        agent_type: params[0] as string,
        name: params[1] as string,
        description: params[2] as string,
        updated_at: params[3] as number,
      });
      return { toArray: () => [] };
    }

    if (normalized.includes('FROM CACHED_COMMANDS WHERE AGENT_TYPE')) {
      const agentType = params[0] as string;
      const filtered = this.rows
        .filter((r) => r.agent_type === agentType)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { toArray: () => filtered };
    }

    if (normalized.includes('FROM CACHED_COMMANDS ORDER BY')) {
      const sorted = [...this.rows].sort((a, b) => a.name.localeCompare(b.name));
      return { toArray: () => sorted };
    }

    return { toArray: () => [] };
  }
}

describe('cached commands DO module', () => {
  let sql: MockSqlStorage;

  beforeEach(() => {
    sql = new MockSqlStorage();
  });

  describe('saveCachedCommands', () => {
    it('persists commands for an agent type', () => {
      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'compact', description: 'Compact conversation' },
        { name: 'help', description: 'Show help' },
      ]);

      const result = getCachedCommands(sql as unknown as SqlStorage, 'claude-code');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('compact');
      expect(result[1].name).toBe('help');
    });

    it('replaces all commands for an agent type on re-save', () => {
      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'compact', description: 'Old desc' },
        { name: 'help', description: 'Old help' },
      ]);

      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'status', description: 'New status command' },
      ]);

      const result = getCachedCommands(sql as unknown as SqlStorage, 'claude-code');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('status');
    });

    it('isolates commands by agent type', () => {
      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'compact', description: 'Compact' },
      ]);
      saveCachedCommands(sql as unknown as SqlStorage, 'other-agent', [
        { name: 'custom', description: 'Custom cmd' },
      ]);

      const claude = getCachedCommands(sql as unknown as SqlStorage, 'claude-code');
      expect(claude).toHaveLength(1);
      expect(claude[0].name).toBe('compact');

      const other = getCachedCommands(sql as unknown as SqlStorage, 'other-agent');
      expect(other).toHaveLength(1);
      expect(other[0].name).toBe('custom');
    });
  });

  describe('getCachedCommands', () => {
    it('returns all commands when no agent type filter', () => {
      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'compact', description: 'Compact' },
      ]);
      saveCachedCommands(sql as unknown as SqlStorage, 'other-agent', [
        { name: 'custom', description: 'Custom' },
      ]);

      const all = getCachedCommands(sql as unknown as SqlStorage);
      expect(all).toHaveLength(2);
    });

    it('returns empty array when no commands cached', () => {
      const result = getCachedCommands(sql as unknown as SqlStorage, 'claude-code');
      expect(result).toEqual([]);
    });

    it('returns correct shape for each command', () => {
      saveCachedCommands(sql as unknown as SqlStorage, 'claude-code', [
        { name: 'help', description: 'Show help info' },
      ]);

      const [cmd] = getCachedCommands(sql as unknown as SqlStorage, 'claude-code');
      expect(cmd).toEqual(expect.objectContaining({
        agentType: 'claude-code',
        name: 'help',
        description: 'Show help info',
      }));
      expect(typeof cmd.updatedAt).toBe('number');
    });
  });
});
