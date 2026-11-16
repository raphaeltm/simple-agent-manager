/**
 * Codex hook configuration and the Codex rule-delivery hook (.codex/hooks/rule-context.mjs).
 * The hook tests run the real script against a fixture repository with the real generated
 * lookup, the way Codex runs it: JSON on stdin, JSON on stdout.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

import { codexRuleScopes, renderCodexRuleScopes } from './agent-codex-rule-scopes';
import { checkCodexHookConfig, hookCommandScripts } from './agent-hook-config';
import { InstructionModel, parseRuleFile } from './agent-instructions';

const ROOT = resolve(import.meta.dirname, '../..');
const HOOK = '.codex/hooks/rule-context.mjs';

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

  it('accepts the repository config', () => {
    const config = TOML.parse(readFileSync(join(ROOT, '.codex/config.toml'), 'utf8'));
    expect(checkCodexHookConfig(config)).toEqual([]);
    const events = Object.keys((config as { hooks: Record<string, unknown> }).hooks).sort();
    expect(events).toEqual(['PreToolUse', 'SessionStart', 'Stop']);
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

/** A small repository: the real hook, three scoped rules, and their generated lookup. */
function fixtureRepo(extraRules: { path: string; text: string }[] = []): string {
  const repo = mkdtempSync(join(tmpdir(), 'codex-rules-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const rules = [
    {
      path: '.claude/rules/10-api.md',
      text: "---\npaths:\n  - 'apps/api/**'\n---\n\n# API Rule\n\nAPI-RULE-CANARY applies to the API.\n",
    },
    {
      path: '.claude/rules/20-go.md',
      text: "---\npaths:\n  - '**/*.go'\n---\n\n# Go Rule\n\nGO-RULE-CANARY applies to Go.\n",
    },
    {
      path: '.claude/rules/30-route.md',
      text: "---\npaths:\n  - 'apps/api/src/routes/special.ts'\n---\n\n# Special Route\n\nSPECIAL-CANARY.\n",
    },
    {
      path: '.claude/rules/01-launch.md',
      text: '# Launch Rule\n\nLAUNCH-CANARY loads at launch.\n',
    },
    ...extraRules,
  ];
  for (const rule of rules) {
    mkdirSync(dirname(join(repo, rule.path)), { recursive: true });
    writeFileSync(join(repo, rule.path), rule.text);
  }
  const model = new InstructionModel(
    rules.map((rule) => parseRuleFile(rule.path, rule.text)),
    { claude: null, agents: null }
  );
  mkdirSync(join(repo, '.codex/hooks'), { recursive: true });
  copyFileSync(join(ROOT, HOOK), join(repo, HOOK));
  writeFileSync(join(repo, '.codex/hooks/rule-scopes.json'), renderCodexRuleScopes(model));
  for (const file of ['apps/api/src/routes/special.ts', 'apps/api/wrangler.toml', 'pkg/main.go']) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), 'content\n');
  }
  return repo;
}

interface HookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    additionalContext?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function hook(
  repo: string,
  event: Record<string, unknown>,
  env: Record<string, string> = {}
): { status: number | null; output: HookOutput; raw: string } {
  const result = spawnSync('node', [join(repo, HOOK)], {
    cwd: repo,
    input: JSON.stringify({ session_id: 'sess', cwd: repo, ...event }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: result.status,
    output: JSON.parse(result.stdout) as HookOutput,
    raw: result.stdout,
  };
}

const bash = (command: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
});
const patch = (body: string) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'apply_patch',
  tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` },
});
const context = (run: { output: HookOutput }) =>
  run.output.hookSpecificOutput?.additionalContext ?? '';
const decision = (run: { output: HookOutput }) => run.output.hookSpecificOutput?.permissionDecision;

describe('Codex rule-context hook', () => {
  it('announces delivery at session start and logs it', () => {
    const repo = fixtureRepo();
    const run = hook(repo, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(run.status).toBe(0);
    expect(context(run)).toContain('SAM rule delivery is active');
    const log = readFileSync(join(repo, '.tmp/instruction-loads/codex-sess.jsonl'), 'utf8');
    expect(log).toContain('"load_reason":"session_start"');
  });

  it('existing file read through the shell: rule bodies arrive, the command is allowed', () => {
    const repo = fixtureRepo();
    hook(repo, { hook_event_name: 'SessionStart', source: 'startup' });
    const run = hook(repo, bash('sed -n 1,5p apps/api/src/routes/special.ts'));
    expect(decision(run)).toBeUndefined();
    const text = context(run);
    expect(text).toContain('SPECIAL-CANARY');
    expect(text).toContain('API-RULE-CANARY');
    // Most specific scope first.
    expect(text.indexOf('SPECIAL-CANARY')).toBeLessThan(text.indexOf('API-RULE-CANARY'));
    // Launch rules are not path-scoped and never come from the hook; frontmatter is stripped.
    expect(text).not.toContain('LAUNCH-CANARY');
    expect(text).not.toContain('paths:');
    // Delivered once per epoch.
    expect(hook(repo, bash('cat apps/api/src/routes/special.ts')).output).toEqual({});
  });

  it('new file through apply_patch: refused once with the rules attached, then allowed', () => {
    const repo = fixtureRepo();
    hook(repo, { hook_event_name: 'SessionStart', source: 'startup' });
    const first = hook(repo, patch('*** Add File: apps/api/src/routes/new.ts\n+export {};'));
    expect(decision(first)).toBe('deny');
    expect(first.output.hookSpecificOutput?.permissionDecisionReason).toContain(
      'apps/api/src/routes/new.ts'
    );
    expect(context(first)).toContain('API-RULE-CANARY');
    const retry = hook(repo, patch('*** Add File: apps/api/src/routes/new.ts\n+export {};'));
    expect(retry.output).toEqual({});
  });

  it('shell-only write: refused once with the rules attached', () => {
    const repo = fixtureRepo();
    const first = hook(repo, bash("printf 'x' > pkg/new.go"));
    expect(decision(first)).toBe('deny');
    expect(context(first)).toContain('GO-RULE-CANARY');
    expect(hook(repo, bash("printf 'x' > pkg/new.go")).output).toEqual({});
  });

  it('control: a path no rule governs gets nothing', () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/readme.txt'), 'x');
    expect(hook(repo, bash('cat docs/readme.txt')).output).toEqual({});
    expect(hook(repo, patch('*** Add File: docs/new.txt\n+x')).output).toEqual({});
  });

  it('a directory argument delivers the rules for its contents', () => {
    const repo = fixtureRepo();
    expect(context(hook(repo, bash('ls apps/api')))).toContain('API-RULE-CANARY');
  });

  it('ignores paths outside the repository and in ignored directories', () => {
    const repo = fixtureRepo();
    expect(hook(repo, bash('cat /etc/hostname ../../outside.go')).output).toEqual({});
    expect(hook(repo, bash('ls node_modules/x/y.go .tmp/z.go')).output).toEqual({});
  });

  it('compaction starts a new epoch, so rules are delivered again', () => {
    const repo = fixtureRepo();
    hook(repo, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(context(hook(repo, bash('cat pkg/main.go')))).toContain('GO-RULE-CANARY');
    expect(hook(repo, bash('cat pkg/main.go')).output).toEqual({});
    hook(repo, { hook_event_name: 'SessionStart', source: 'resume' });
    expect(hook(repo, bash('cat pkg/main.go')).output).toEqual({});
    hook(repo, { hook_event_name: 'SessionStart', source: 'compact' });
    expect(context(hook(repo, bash('cat pkg/main.go')))).toContain('GO-RULE-CANARY');
  });

  it('bounds its output and discloses rules it did not deliver yet', () => {
    const big = Array.from({ length: 12 }, (_, index) => ({
      path: `.claude/rules/9${index.toString().padStart(2, '0')}-big.md`,
      text: `---\npaths:\n  - 'apps/api/**'\n---\n\n# Big ${index}\n\nBIG-${index} ${'word '.repeat(1200)}\n`,
    }));
    const repo = fixtureRepo(big);
    const budget = '20000';
    const first = hook(repo, bash('cat apps/api/wrangler.toml'), {
      SAM_CODEX_RULE_CONTEXT_MAX_BYTES: budget,
    });
    const text = context(first);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(Number(budget));
    expect(text).toContain('not delivered yet');
    // The remainder arrives on later calls until every rule has been delivered.
    const delivered = new Set<string>();
    let run = first;
    for (let call = 0; call < 10 && context(run) !== ''; call++) {
      for (const match of context(run).matchAll(/===== (\S+) =====/g))
        delivered.add(match[1] ?? '');
      run = hook(repo, bash('cat apps/api/wrangler.toml'), {
        SAM_CODEX_RULE_CONTEXT_MAX_BYTES: budget,
      });
    }
    expect(delivered.size).toBe(13);
  });

  it('never fails the session: malformed input or a missing lookup prints {}', () => {
    const repo = fixtureRepo();
    const malformed = spawnSync('node', [join(repo, HOOK)], {
      input: 'not json',
      encoding: 'utf8',
    });
    expect(malformed.status).toBe(0);
    expect(JSON.parse(malformed.stdout)).toEqual({});
    writeFileSync(join(repo, '.codex/hooks/rule-scopes.json'), '{');
    const broken = hook(repo, bash('cat pkg/main.go'));
    expect(broken.status).toBe(0);
    expect(broken.output).toEqual({});
  });

  it('the --show command prints the rules for a path', () => {
    const repo = fixtureRepo();
    const result = spawnSync('node', [join(repo, HOOK), '--show', 'pkg/main.go'], {
      cwd: repo,
      encoding: 'utf8',
    });
    expect(result.stdout).toContain('GO-RULE-CANARY');
  });

  it('uses only Node built-ins, so it runs without node_modules', () => {
    const source = readFileSync(join(ROOT, HOOK), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });
});

describe('generated Codex rule lookup', () => {
  it('lists only path-scoped rules, with patterns that match what the model matches', () => {
    const rules = [
      parseRuleFile('.claude/rules/a.md', "---\npaths:\n  - 'apps/api/**'\n---\n\n# A\n"),
      parseRuleFile('.claude/rules/b.md', '# B launch\n'),
    ];
    const model = new InstructionModel(rules, { claude: null, agents: null });
    const scopes = codexRuleScopes(model);
    expect(scopes.map((scope) => scope.path)).toEqual(['.claude/rules/a.md']);
    const [scoped] = rules;
    const regex = new RegExp(scopes[0]?.patterns[0]?.regex ?? '(?!)');
    for (const file of ['apps/api/src/index.ts', 'apps/api-old/x.ts', 'apps/api']) {
      expect(regex.test(file)).toBe(scoped !== undefined && model.loadsOnAccess(scoped, file));
    }
  });

  it('the committed lookup exists (staleness is enforced by --check)', () => {
    expect(existsSync(join(ROOT, '.codex/hooks/rule-scopes.json'))).toBe(true);
  });
});
