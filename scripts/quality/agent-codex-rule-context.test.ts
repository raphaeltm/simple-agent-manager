/**
 * The Codex rule-delivery hook (.codex/hooks/rule-context.mjs), driven the way Codex runs
 * it: JSON on stdin, JSON on stdout, against a fixture repository with a generated lookup.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import TOML from '@iarna/toml';
import { afterEach, describe, expect, it } from 'vitest';

import { codexRuleScopes, renderCodexRuleScopes } from './agent-codex-rule-scopes';
import { InstructionModel, parseRuleFile } from './agent-instructions';

const ROOT = resolve(import.meta.dirname, '../..');
const HOOK = '.codex/hooks/rule-context.mjs';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A small repository: the real hook, three scoped rules, and their generated lookup. */
function fixtureRepo(extraRules: { path: string; text: string }[] = []): string {
  // realpath: the hook derives its root from its own (resolved) location.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'codex-rules-')));
  created.push(repo);
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

describe('Codex rule-context hook: writes and deny-once', () => {
  it('a write whose rules exceed the cap is refused once, then allowed with the rest', () => {
    const big = Array.from({ length: 6 }, (_, index) => ({
      path: `.claude/rules/9${index}-big.md`,
      text: `---\npaths:\n  - 'pkg/**'\n---\n\n# Big ${index}\n\nBIG-${index} ${'word '.repeat(1200)}\n`,
    }));
    const repo = fixtureRepo(big);
    const env = { SAM_CODEX_RULE_CONTEXT_MAX_BYTES: '16000' };
    const write = patch('*** Update File: pkg/main.go\n@@\n-content\n+changed');
    const first = hook(repo, write, env);
    expect(decision(first)).toBe('deny');
    expect(context(first)).toContain('not delivered yet');
    // The identical retry is allowed and carries the next batch.
    const second = hook(repo, write, env);
    expect(decision(second)).toBeUndefined();
    expect(context(second)).toContain('===== .claude/rules/');
    // A different set of paths gets its own single refusal.
    const other = hook(repo, patch('*** Add File: pkg/other.go\n+package pkg'), env);
    expect(decision(other)).toBe(context(other) === '' ? undefined : 'deny');
  });

  it('never refuses a write when no rule text could be attached', () => {
    const huge = {
      path: '.claude/rules/99-huge.md',
      text: `---\npaths:\n  - 'big/**'\n---\n\n# Huge\n\n${'x '.repeat(30000)}\n`,
    };
    const repo = fixtureRepo([huge]);
    mkdirSync(join(repo, 'big'), { recursive: true });
    const run = hook(repo, patch('*** Add File: big/new.txt\n+x'), {
      SAM_CODEX_RULE_CONTEXT_MAX_BYTES: '8000',
    });
    expect(decision(run)).toBeUndefined();
    expect(context(run)).toContain('99-huge.md');
  });

  it.each([
    ['tee', 'echo x | tee pkg/main.go'],
    ['mv', 'mv pkg/main.go pkg/moved.go'],
    ['rm', 'rm pkg/main.go'],
    ['sed -i', "sed -i 's/a/b/' pkg/main.go"],
    ['git mv', 'git mv pkg/main.go pkg/renamed.go'],
    ['append redirect', 'echo x >> pkg/main.go'],
  ])('%s counts as a write and is refused once', (_name, command) => {
    const repo = fixtureRepo();
    expect(decision(hook(repo, bash(command)))).toBe('deny');
  });

  it.each([
    ['plain read', 'cat pkg/main.go'],
    ['stderr to stdout', 'cat pkg/main.go 2>&1'],
    ['discarded output', 'cat pkg/main.go > /dev/null'],
  ])('%s is a read: rules arrive, nothing is refused', (_name, command) => {
    const repo = fixtureRepo();
    const run = hook(repo, bash(command));
    expect(decision(run)).toBeUndefined();
    expect(context(run)).toContain('GO-RULE-CANARY');
  });

  it.each([
    ['Update File', '*** Update File: pkg/main.go\n@@\n-content\n+x'],
    ['Delete File', '*** Delete File: pkg/main.go'],
    ['Move to', '*** Update File: docs-none/a.txt\n*** Move to: pkg/moved.go\n@@\n-a\n+b'],
  ])('apply_patch %s targets are recognised', (_name, body) => {
    const repo = fixtureRepo();
    const run = hook(repo, patch(body));
    expect(decision(run)).toBe('deny');
    expect(context(run)).toContain('GO-RULE-CANARY');
  });
});

describe('Codex rule-context hook: paths and sessions', () => {
  it('follows cd inside the command and a subdirectory cwd', () => {
    const repo = fixtureRepo();
    expect(context(hook(repo, bash('cd apps/api && sed -n 1,3p wrangler.toml')))).toContain(
      'API-RULE-CANARY'
    );
    const fromSub = fixtureRepo();
    const run = hook(fromSub, { ...bash('cat wrangler.toml'), cwd: join(fromSub, 'apps/api') });
    expect(context(run)).toContain('API-RULE-CANARY');
    const relativePatch = hook(fixtureRepo(), {
      ...patch('*** Add File: src/routes/new.ts\n+x'),
      cwd: join(created[created.length - 1] ?? '', 'apps/api'),
    });
    expect(context(relativePatch)).toContain('API-RULE-CANARY');
  });

  it('ignores files under node_modules and .tmp even when they exist', () => {
    const repo = fixtureRepo();
    for (const file of ['node_modules/x/y.go', '.tmp/z.go']) {
      mkdirSync(dirname(join(repo, file)), { recursive: true });
      writeFileSync(join(repo, file), 'x');
    }
    expect(hook(repo, bash('cat node_modules/x/y.go .tmp/z.go')).output).toEqual({});
    // Liveness: the same session still delivers for a governed file.
    expect(context(hook(repo, bash('cat pkg/main.go')))).toContain('GO-RULE-CANARY');
  });

  it.each([
    ['startup', true],
    ['clear', true],
    ['compact', true],
    ['resume', false],
    ['fork', false],
  ])('SessionStart %s resets delivery: %s', (source, resets) => {
    const repo = fixtureRepo();
    hook(repo, { hook_event_name: 'SessionStart', source: 'startup' });
    expect(context(hook(repo, bash('cat pkg/main.go')))).toContain('GO-RULE-CANARY');
    hook(repo, { hook_event_name: 'SessionStart', source });
    const again = context(hook(repo, bash('cat pkg/main.go')));
    expect(again.includes('GO-RULE-CANARY')).toBe(resets);
  });

  it('keeps delivery state per session, inside the state directory', () => {
    const repo = fixtureRepo();
    expect(context(hook(repo, { ...bash('cat pkg/main.go'), session_id: 'a' }))).toContain(
      'GO-RULE-CANARY'
    );
    expect(context(hook(repo, { ...bash('cat pkg/main.go'), session_id: 'b' }))).toContain(
      'GO-RULE-CANARY'
    );
    hook(repo, { ...bash('cat pkg/main.go'), session_id: `../../${'x'.repeat(300)}` });
    const files = readdirSync(join(repo, '.tmp/codex-rule-context'));
    expect(files.length).toBe(3);
    expect(files.every((file) => file.length < 120 && !file.includes('/'))).toBe(true);
  });

  it('logs an error, and still prints {}, when the lookup is unreadable', () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, '.codex/hooks/rule-scopes.json'), '{');
    const run = hook(repo, bash('cat pkg/main.go'));
    expect(run.output).toEqual({});
    const log = readFileSync(join(repo, '.tmp/instruction-loads/codex-sess.jsonl'), 'utf8');
    expect(log).toContain('"load_reason":"error"');
  });

  it('refuses to read a lookup entry outside the rules directory', () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, 'secret.txt'), 'SECRET-CANARY');
    const lookup = JSON.parse(
      readFileSync(join(repo, '.codex/hooks/rule-scopes.json'), 'utf8')
    ) as {
      rules: { path: string; title: string; patterns: unknown[] }[];
    };
    const [first] = lookup.rules;
    if (first) first.path = 'secret.txt';
    writeFileSync(join(repo, '.codex/hooks/rule-scopes.json'), JSON.stringify(lookup));
    const text = context(hook(repo, bash('cat apps/api/wrangler.toml')));
    expect(text).not.toContain('SECRET-CANARY');
  });

  it('stays fast and bounded on pathological commands', () => {
    const repo = fixtureRepo();
    const started = Date.now();
    const run = hook(repo, bash(`${'cd a '.repeat(20000)}; touch apps/${'A'.repeat(5000)}.ts`));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.status).toBe(0);
    expect(run.raw.length).toBeLessThan(60000);
  });
});

describe('Codex hook wiring in .codex/config.toml', () => {
  const config = TOML.parse(readFileSync(join(ROOT, '.codex/config.toml'), 'utf8')) as {
    hooks: Record<
      string,
      { matcher?: string; hooks: { command: string; additionalContextLimit?: number }[] }[]
    >;
  };

  it('routes SessionStart sources and the tools the hook handles to it', () => {
    const start = config.hooks.SessionStart?.[0];
    const pre = config.hooks.PreToolUse?.[0];
    for (const source of ['startup', 'resume', 'clear', 'compact', 'fork']) {
      expect(new RegExp(start?.matcher ?? '(?!)').test(source)).toBe(true);
    }
    for (const tool of ['Bash', 'apply_patch']) {
      expect(new RegExp(pre?.matcher ?? '(?!)').test(tool)).toBe(true);
    }
    expect(start?.hooks[0]?.command).toContain(HOOK);
    expect(pre?.hooks[0]?.command).toContain(HOOK);
    expect(config.hooks.Stop?.[0]?.hooks[0]?.command).toContain(
      '.claude/hooks/verify-test-quality.mjs'
    );
  });

  it('sets additionalContextLimit above the hook byte cap, so Codex never spills', () => {
    const source = readFileSync(join(ROOT, HOOK), 'utf8');
    const cap = Number(/MAX_MAX_BYTES = ([\d_]+)/.exec(source)?.[1]?.replaceAll('_', ''));
    expect(cap).toBeGreaterThan(0);
    for (const group of [
      ...(config.hooks.SessionStart ?? []),
      ...(config.hooks.PreToolUse ?? []),
    ]) {
      // Three bytes per token is a conservative floor for English prose.
      expect((group.hooks[0]?.additionalContextLimit ?? 0) * 3).toBeGreaterThan(cap);
    }
  });

  it('delivers a real rule for a real path with the committed lookup', () => {
    const result = spawnSync('node', [join(ROOT, HOOK)], {
      cwd: ROOT,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'sed -n 1,3p packages/cli/go.mod' },
        session_id: `wiring-smoke-${process.pid}-${Date.now()}`,
        cwd: ROOT,
      }),
      encoding: 'utf8',
    });
    const output = JSON.parse(result.stdout) as HookOutput;
    expect(output.hookSpecificOutput?.additionalContext).toContain('36-cli-quality.md');
  });
});
