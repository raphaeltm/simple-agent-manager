import { describe, expect, it } from 'vitest';
import { getStaticCommands, getAllStaticCommands } from '../../../src/commands/registry';

describe('getStaticCommands', () => {
  it('returns Claude Code commands for claude-code agent type', () => {
    const commands = getStaticCommands('claude-code');
    expect(commands.length).toBeGreaterThan(0);

    const names = commands.map((c) => c.name);
    expect(names).toContain('compact');
    expect(names).toContain('help');
    expect(names).toContain('model');
    expect(names).toContain('review');
    expect(names).toContain('status');
  });

  it('all Claude Code commands have source agent', () => {
    const commands = getStaticCommands('claude-code');
    for (const cmd of commands) {
      expect(cmd.source).toBe('agent');
      expect(cmd.name).toBeTruthy();
      expect(cmd.description).toBeTruthy();
    }
  });

  it('returns empty array for unknown agent type', () => {
    expect(getStaticCommands('unknown-agent')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(getStaticCommands('')).toEqual([]);
  });
});

describe('getAllStaticCommands', () => {
  it('returns all commands across all agent types', () => {
    const all = getAllStaticCommands();
    const claudeCode = getStaticCommands('claude-code');
    expect(all.length).toBe(claudeCode.length);
  });

  it('includes commands from the Claude Code registry', () => {
    const names = getAllStaticCommands().map((c) => c.name);
    expect(names).toContain('compact');
    expect(names).toContain('help');
  });
});
