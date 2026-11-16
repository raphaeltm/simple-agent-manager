import { describe, expect, it } from 'vitest';

import { compareObservedLoads, parseObservedLog } from './agent-instruction-observed';
import {
  checkCitationsCovered,
  checkClaudeHookConfig,
  checkNoDuplicateBodies,
  checkPatterns,
  compilePattern,
  InstructionModel,
  parseRuleFile,
  unsupportedPatternReason,
} from './agent-instructions';
import {
  applyGeneratedBlock,
  describeScope,
  INDEX_BEGIN,
  renderDirectoryIndex,
  renderRootIndex,
} from './agent-rule-index';

const rule = (path: string, frontmatter: string | null, body = '# Title\n\nBody.\n') =>
  parseRuleFile(path, frontmatter === null ? body : `---\n${frontmatter}\n---\n\n${body}`);

const model = (...rules: ReturnType<typeof rule>[]) =>
  new InstructionModel(rules, { claude: 'CLAUDE.md', agents: 'AGENTS.md' });

describe('parseRuleFile', () => {
  it('reads a paths list and the directory that owns the rule', () => {
    const parsed = rule(
      'apps/web/.claude/rules/15-nav.md',
      "paths:\n  - 'src/**'\n  - 'tests/a.ts'"
    );
    expect(parsed.baseDir).toBe('apps/web');
    expect(parsed.paths).toEqual(['src/**', 'tests/a.ts']);
    expect(parsed.title).toBe('Title');
  });

  it('accepts a comma-separated paths string', () => {
    expect(rule('.claude/rules/a.md', 'paths: apps/api/**, packages/shared/**').paths).toEqual([
      'apps/api/**',
      'packages/shared/**',
    ]);
  });

  it('treats a rule without frontmatter, or with unparseable frontmatter, as unconditional', () => {
    expect(rule('.claude/rules/a.md', null).paths).toBeNull();
    // Claude Code loads a rule whose frontmatter does not parse as if it had no paths.
    expect(rule('.claude/rules/a.md', 'paths: [unclosed').paths).toBeNull();
  });
});

describe('pattern subset', () => {
  it.each([
    ['apps/api/**', 'apps/api/src/index.ts', true],
    ['apps/api/**', 'apps/api-old/src/index.ts', false],
    ['apps/api/src/env.ts', 'apps/api/src/env.ts', true],
    ['apps/api/src/env.ts', 'apps/api/src/env.ts.bak', false],
    ['**/*.go', 'packages/vm-agent/internal/server/server.go', true],
    ['**/*.go', 'main.go', true],
    ['**/*.go', 'apps/api/src/index.ts', false],
    ['apps/*/wrangler.toml', 'apps/api/wrangler.toml', true],
    ['apps/*/wrangler.toml', 'apps/api/nested/wrangler.toml', false],
    ['packages/cli', 'packages/cli/cmd/main.go', true],
    ['sonar-project.properties', 'sonar-project.properties', true],
    ['sonar-project.properties', 'packages/cli/sonar-project.properties', true],
  ])('%s vs %s -> %s', (pattern, file, expected) => {
    expect(unsupportedPatternReason(pattern)).toBeNull();
    expect(compilePattern(pattern).test(file)).toBe(expected);
  });

  it.each([
    '/abs/**',
    '!apps/**',
    '../x/**',
    'src/**/*.{ts,tsx}',
    'src/[ab].ts',
    '*.md',
    'apps/**x',
  ])('rejects %s as outside the supported subset', (pattern) => {
    expect(unsupportedPatternReason(pattern)).not.toBeNull();
  });
});

describe('InstructionModel', () => {
  const launch = rule('.claude/rules/02-gates.md', null);
  const scoped = rule(
    '.claude/rules/45-do-mutex.md',
    "paths:\n  - 'apps/api/**'\n  - 'packages/project-data/**'"
  );
  const nestedBatch = rule('packages/shared/.claude/rules/52-models.md', null);
  const nestedScoped = rule(
    'apps/web/.claude/rules/15-nav.md',
    "paths:\n  - 'src/components/Nav.tsx'"
  );
  const m = model(launch, scoped, nestedBatch, nestedScoped);

  it('loads only unconditional root rules at launch', () => {
    expect(m.claudeLaunchRules().map((r) => r.path)).toEqual(['.claude/rules/02-gates.md']);
  });

  it('loads a root path-scoped rule for matching files in any package', () => {
    const paths = (file: string) => m.lazyRulesFor(file).map((r) => r.path);
    expect(paths('packages/project-data/src/do/index.ts')).toEqual([
      '.claude/rules/45-do-mutex.md',
    ]);
    expect(paths('apps/api/src/index.ts')).toEqual(['.claude/rules/45-do-mutex.md']);
    expect(paths('packages/ui/src/Button.tsx')).toEqual([]);
  });

  it('loads every unconditional nested rule for any file under its directory', () => {
    expect(m.lazyRulesFor('packages/shared/package.json').map((r) => r.path)).toEqual([
      'packages/shared/.claude/rules/52-models.md',
    ]);
    expect(m.firstAccessBatches().get('packages/shared')).toHaveLength(1);
  });

  it('matches a nested rule against paths relative to its own directory', () => {
    expect(m.loadsOnAccess(nestedScoped, 'apps/web/src/components/Nav.tsx')).toBe(true);
    expect(m.loadsOnAccess(nestedScoped, 'apps/web/src/components/Other.tsx')).toBe(false);
    expect(m.loadsOnAccess(nestedScoped, 'src/components/Nav.tsx')).toBe(false);
  });
});

describe('checkPatterns', () => {
  const tracked = ['apps/api/src/index.ts', 'apps/web/src/components/NavSidebar.tsx'];

  it('flags the repository-rooted glob inside a nested rule directory that never loaded on main', () => {
    // apps/api/.claude/rules/06-api-patterns.md shipped with `paths: apps/api/**`. Claude Code
    // resolves that against apps/api/, giving apps/api/apps/api/**, which matches nothing.
    const dead = rule('apps/api/.claude/rules/06-api-patterns.md', "paths:\n  - 'apps/api/**'");
    const findings = checkPatterns({ model: model(dead), trackedFiles: tracked });
    expect(findings).toHaveLength(1);
    expect(findings[0].check).toBe('dead-pattern');
  });

  it('passes the same glob once the rule lives at the repository root', () => {
    const alive = rule('.claude/rules/06-api-patterns.md', "paths:\n  - 'apps/api/**'");
    expect(checkPatterns({ model: model(alive), trackedFiles: tracked })).toEqual([]);
  });

  it('flags a pattern left behind when its file is renamed', () => {
    const stale = rule(
      '.claude/rules/15-nav.md',
      "paths:\n  - 'apps/web/src/components/OldNav.tsx'"
    );
    expect(checkPatterns({ model: model(stale), trackedFiles: tracked })[0].check).toBe(
      'dead-pattern'
    );
  });

  it('reports unsupported syntax instead of guessing what it matches', () => {
    const fancy = rule('.claude/rules/a.md', "paths:\n  - 'apps/**/*.{ts,tsx}'");
    expect(checkPatterns({ model: model(fancy), trackedFiles: tracked })[0].check).toBe(
      'pattern-syntax'
    );
  });
});

describe('checkCitationsCovered', () => {
  const tracked = [
    'apps/api/src/index.ts',
    'packages/project-data/src/do/knowledge.ts',
    'packages/project-data/src/do/policies.ts',
  ];
  const body =
    '# Capped selection\n\nSee `packages/project-data/src/do/knowledge.ts:500` and `docs/guide.md`.\n';

  it('flags a rule that names code it does not load for (code moved, rule stayed)', () => {
    const left = rule('.claude/rules/65-capped.md', "paths:\n  - 'apps/api/**'", body);
    const findings = checkCitationsCovered({ model: model(left), trackedFiles: tracked });
    expect(findings.map((f) => f.check)).toEqual(['citation-not-covered']);
    expect(findings[0].message).toContain('packages/project-data/src/do/knowledge.ts');
  });

  it('passes once the scope follows the code, and still loads for the original home', () => {
    const moved = rule(
      '.claude/rules/65-capped.md',
      "paths:\n  - 'apps/api/**'\n  - 'packages/project-data/**'",
      body
    );
    const m = model(moved);
    expect(checkCitationsCovered({ model: m, trackedFiles: tracked })).toEqual([]);
    expect(m.loadsOnAccess(moved, 'apps/api/src/index.ts')).toBe(true);
  });

  it('treats a named directory as covered when the rule loads for a file inside it', () => {
    const dirBody = '# R\n\nApplies to `packages/project-data/src/do`.\n';
    const covered = rule(
      '.claude/rules/a.md',
      "paths:\n  - 'packages/project-data/src/do/policies.ts'",
      dirBody
    );
    const uncovered = rule('.claude/rules/b.md', "paths:\n  - 'apps/api/**'", dirBody);
    expect(checkCitationsCovered({ model: model(covered), trackedFiles: tracked })).toEqual([]);
    expect(checkCitationsCovered({ model: model(uncovered), trackedFiles: tracked })).toHaveLength(
      1
    );
  });

  it('does not constrain a rule that is always loaded', () => {
    const always = rule('.claude/rules/65-capped.md', null, body);
    expect(checkCitationsCovered({ model: model(always), trackedFiles: tracked })).toEqual([]);
  });
});

describe('checkNoDuplicateBodies', () => {
  it('flags copies even when their frontmatter differs', () => {
    const a = rule('apps/web/.claude/rules/04-ui.md', "paths:\n  - 'src/**'");
    const b = rule('packages/ui/.claude/rules/04-ui.md', null);
    const c = rule('.claude/rules/05-other.md', null, '# Other\n');
    const findings = checkNoDuplicateBodies([a, b, c]);
    expect(findings).toEqual([
      {
        check: 'duplicate-rule',
        file: 'packages/ui/.claude/rules/04-ui.md',
        message: 'is a copy of apps/web/.claude/rules/04-ui.md',
      },
    ]);
  });
});

describe('checkClaudeHookConfig', () => {
  it('flags the Stop entry that shipped without a hooks array and never ran', () => {
    // Exact shape of .claude/settings.json from 2026-05-17 until this check existed.
    const shipped = {
      hooks: {
        Stop: [
          { type: 'command', command: '.claude/hooks/verify-test-quality.sh', timeout: 30000 },
        ],
      },
    };
    const problems = checkClaudeHookConfig(shipped);
    expect(problems).toHaveLength(1);
    expect(problems[0].event).toBe('Stop');
  });

  it('accepts matcher groups that hold a hooks array', () => {
    const fixed = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x.sh', timeout: 30 }] }] },
    };
    expect(checkClaudeHookConfig(fixed)).toEqual([]);
    expect(checkClaudeHookConfig({})).toEqual([]);
  });

  it('flags a timeout written in milliseconds', () => {
    const slow = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x.sh', timeout: 30000 }] }] },
    };
    expect(checkClaudeHookConfig(slow)[0].message).toContain('seconds');
  });
});

describe('generated indexes', () => {
  const scoped = rule(
    '.claude/rules/45-do-mutex.md',
    "paths:\n  - 'apps/api/**'\n  - 'packages/project-data/src/do/index.ts'"
  );
  const launch = rule('.claude/rules/02-gates.md', null);
  const m = model(scoped, launch);
  const tracked = [
    'apps/api/src/index.ts',
    'packages/project-data/src/do/index.ts',
    'packages/ui/src/a.tsx',
  ];

  it('lists scoped rules, not launch rules, in the root index', () => {
    const index = renderRootIndex(m);
    expect(index).toContain(
      '`45-do-mutex.md`: Title. Loads for: apps/api, packages/project-data (part)'
    );
    expect(index).not.toContain('02-gates.md');
  });

  it('lists for a directory exactly the rules that load for its files', () => {
    expect(renderDirectoryIndex(m, 'packages/project-data', tracked)).toContain(
      '.claude/rules/45-do-mutex.md'
    );
    expect(renderDirectoryIndex(m, 'packages/ui', tracked)).toContain('No path-scoped rules apply');
  });

  it('collapses a partial area into the whole area when both are present', () => {
    const both = rule('.claude/rules/a.md', "paths:\n  - 'apps/api/src/env.ts'\n  - 'apps/api/**'");
    expect(describeScope(both)).toBe('apps/api');
  });

  it('replaces an existing block and is idempotent', () => {
    const once = applyGeneratedBlock('# Doc\n\nText.\n', renderRootIndex(m));
    expect(once.startsWith('# Doc\n\nText.\n\n' + INDEX_BEGIN)).toBe(true);
    expect(applyGeneratedBlock(once, renderRootIndex(m))).toBe(once);
  });
});

describe('compareObservedLoads', () => {
  const launch = rule('.claude/rules/02-gates.md', null);
  const scoped = rule('.claude/rules/45-do-mutex.md', "paths:\n  - 'packages/project-data/**'");
  const m = model(launch, scoped);
  const line = (entry: object) => JSON.stringify({ memory_type: 'Project', ...entry });

  it('agrees with a session that loaded what the model predicts', () => {
    const log = parseObservedLog(
      [
        line({ load_reason: 'session_start', file: 'CLAUDE.md' }),
        line({ load_reason: 'session_start', file: '.claude/rules/02-gates.md' }),
        line({
          load_reason: 'path_glob_match',
          file: '.claude/rules/45-do-mutex.md',
          trigger: 'packages/project-data/src/do/index.ts',
        }),
      ].join('\n')
    );
    expect(
      compareObservedLoads(m, log, ['packages/project-data/src/do/index.ts']).mismatches
    ).toEqual([]);
  });

  it('reports a rule the model expects that the session never loaded', () => {
    const log = parseObservedLog(line({ load_reason: 'session_start', file: 'CLAUDE.md' }));
    const result = compareObservedLoads(m, log, ['packages/project-data/src/do/index.ts']);
    expect(result.mismatches).toContain(
      '.claude/rules/02-gates.md should load at launch but was not logged'
    );
    expect(result.mismatches).toContain(
      '.claude/rules/45-do-mutex.md should load for packages/project-data/src/do/index.ts but was never logged'
    );
  });

  it('reports a load the model did not predict', () => {
    const log = parseObservedLog(
      line({
        load_reason: 'path_glob_match',
        file: '.claude/rules/45-do-mutex.md',
        trigger: 'apps/web/src/a.tsx',
      })
    );
    expect(compareObservedLoads(m, log, []).mismatches).toEqual([
      '.claude/rules/45-do-mutex.md loaded for apps/web/src/a.tsx but the model predicts no load',
    ]);
  });

  it('ignores user-level memory files', () => {
    const log = parseObservedLog(
      JSON.stringify({
        memory_type: 'User',
        load_reason: 'session_start',
        file: '/home/u/.claude/CLAUDE.md',
      })
    );
    expect(compareObservedLoads(m, log, []).mismatches).toEqual([]);
  });
});
