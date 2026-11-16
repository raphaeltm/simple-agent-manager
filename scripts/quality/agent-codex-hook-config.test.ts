/**
 * Codex hook configuration checks (scripts/quality/agent-hook-config.ts). Codex skips a
 * matcher group with no handlers without an error, which is how the flat [[hooks.Stop]] entry
 * in .codex/config.toml ran nothing from the day it was added.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import { checkCodexHookConfig, hookCommandScripts } from './agent-hook-config';

const ROOT = resolve(import.meta.dirname, '../..');

describe('checkCodexHookConfig', () => {
  it('rejects the flat [[hooks.Stop]] entry that ran nothing since it was added', () => {
    const flat = TOML.parse(
      '[[hooks.Stop]]\ntype = "command"\ncommand = ".claude/hooks/verify-test-quality.sh"\ntimeout = 30000\n'
    );
    const messages = checkCodexHookConfig(flat).map((problem) => problem.message);
    expect(messages.some((message) => message.includes('"type" at matcher-group level'))).toBe(
      true
    );
    expect(messages.some((message) => message.includes('has no [[hooks.Stop.hooks]]'))).toBe(true);
  });

  it('accepts the repository config and a well-formed entry', () => {
    const config = TOML.parse(readFileSync(join(ROOT, '.codex/config.toml'), 'utf8'));
    expect(checkCodexHookConfig(config)).toEqual([]);
    const nested = TOML.parse(
      '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "node x.mjs"\ntimeout = 30\n'
    );
    expect(checkCodexHookConfig(nested)).toEqual([]);
    const short = {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x', timeout: 3 }] }] },
    };
    expect(checkCodexHookConfig(short)).toEqual([]);
  });

  it.each([
    ['unknown event', { hooks: { OnStop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }],
    ['skipped handler type', { hooks: { Stop: [{ hooks: [{ type: 'prompt' }] }] } }],
    ['missing command', { hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } }],
    [
      'millisecond timeout',
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 30000 }] }] } },
    ],
    [
      'SessionEnd timeout above three seconds',
      { hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'x', timeout: 10 }] }] } },
    ],
    [
      'misspelled handler field',
      { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', timout: 3 }] }] } },
    ],
    [
      'invalid matcher',
      { hooks: { PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'x' }] }] } },
    ],
    ['hooks disabled', { features: { hooks: false } }],
  ])('rejects %s', (_name, config) => {
    expect(checkCodexHookConfig(config).length).toBeGreaterThan(0);
  });

  it('names the repository scripts a command runs', () => {
    expect(
      hookCommandScripts('node "$(git rev-parse --show-toplevel)/.codex/hooks/rule-context.mjs"')
    ).toEqual(['.codex/hooks/rule-context.mjs']);
    expect(
      hookCommandScripts('node "$CLAUDE_PROJECT_DIR"/.claude/hooks/verify-test-quality.mjs')
    ).toEqual(['.claude/hooks/verify-test-quality.mjs']);
  });
});
