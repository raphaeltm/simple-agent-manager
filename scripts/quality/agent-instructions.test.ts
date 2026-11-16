import { describe, expect, it } from 'vitest';

import { checkClaudeHookConfig } from './agent-hook-config';
import {
  checkCodexChainSizes,
  checkCodexEntryFiles,
  checkDirectoriesHaveIndex,
  checkLaunchRuleBaseline,
  checkRuleReferencesInSource,
  checkRulesLiveAtRoot,
  ruleFilesNamedIn,
} from './agent-instruction-guards';
import { compareObservedLoads, parseObservedLog } from './agent-instruction-observed';
import {
  checkCitationsCovered,
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
  renderLaunchRuleIndex,
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
    ['src/components/*.tsx', 'src/components/Foo.tsx', true],
    ['src/components/*.tsx', 'src/components/Foo.tsx/child.tsx', false],
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
      '`45-do-mutex.md`: Title. Loads for: apps/api; packages/project-data (src/do/index.ts)'
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

  it('puts wildcard patterns in backticks so Markdown does not read them as emphasis', () => {
    const anyDepth = rule('.claude/rules/a.md', "paths:\n  - '**/*.go'\n  - 'Makefile'");
    expect(describeScope(anyDepth)).toBe('`**/*.go`; Makefile');
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
    expect(compareObservedLoads(m, log, [], { lazyOnly: true }).mismatches).toEqual([
      '.claude/rules/45-do-mutex.md loaded for apps/web/src/a.tsx but the model predicts no load',
    ]);
  });

  it('ignores user-level memory files beside a complete project launch set', () => {
    const log = parseObservedLog(
      [
        line({ load_reason: 'session_start', file: 'CLAUDE.md' }),
        line({ load_reason: 'session_start', file: '.claude/rules/02-gates.md' }),
        JSON.stringify({
          memory_type: 'User',
          load_reason: 'session_start',
          file: '/home/u/.claude/CLAUDE.md',
        }),
      ].join('\n')
    );
    expect(compareObservedLoads(m, log, []).mismatches).toEqual([]);
  });
});

describe('checkLaunchRuleBaseline', () => {
  const gates = rule('.claude/rules/02-gates.md', null);
  const constitution = rule('.claude/rules/03-constitution.md', null);
  const recorded = ['.claude/rules/02-gates.md', '.claude/rules/03-constitution.md'];

  it('passes when the launch set is exactly the recorded list', () => {
    expect(checkLaunchRuleBaseline(model(gates, constitution), recorded)).toEqual([]);
  });

  it('flags a launch rule that was given paths, which every other check accepts', () => {
    // Scoping 03-constitution to apps/api/** is a valid, live pattern.
    const demoted = rule('.claude/rules/03-constitution.md', "paths:\n  - 'apps/api/**'");
    const m = model(gates, demoted);
    expect(checkPatterns({ model: m, trackedFiles: ['apps/api/src/index.ts'] })).toEqual([]);
    expect(checkLaunchRuleBaseline(m, recorded).map((f) => [f.check, f.file])).toEqual([
      ['launch-rule-removed', '.claude/rules/03-constitution.md'],
    ]);
  });

  it('flags a new unconditional rule until it is recorded', () => {
    const findings = checkLaunchRuleBaseline(model(gates, constitution), [recorded[0]]);
    expect(findings.map((f) => f.check)).toEqual(['launch-rule-unrecorded']);
  });
});

describe('Codex route guards', () => {
  const scoped = rule('.claude/rules/36-cli.md', "paths:\n  - 'packages/cli/**'");
  const tracked = [
    'AGENTS.md',
    'packages/cli/go.mod',
    'packages/ui/AGENTS.md',
    'packages/ui/a.tsx',
  ];

  it('flags a workspace directory that has scoped rules and no AGENTS.md', () => {
    const findings = checkDirectoriesHaveIndex(model(scoped), tracked);
    expect(findings.map((f) => f.file)).toEqual(['packages/cli/AGENTS.md']);
  });

  it('passes once the directory has an AGENTS.md, and ignores directories with no rules', () => {
    const withIndex = [...tracked, 'packages/cli/AGENTS.md'];
    expect(checkDirectoriesHaveIndex(model(scoped), withIndex)).toEqual([]);
    expect(checkDirectoriesHaveIndex(model(), ['packages/cli/go.mod'])).toEqual([]);
  });

  it('flags a missing root AGENTS.md and any AGENTS.override.md', () => {
    expect(checkCodexEntryFiles(['CLAUDE.md']).map((f) => f.file)).toEqual(['AGENTS.md']);
    expect(checkCodexEntryFiles(['AGENTS.md', 'AGENTS.override.md']).map((f) => f.file)).toEqual([
      'AGENTS.override.md',
    ]);
    expect(checkCodexEntryFiles(['AGENTS.md'])).toEqual([]);
  });

  it('names the launch rules, not the scoped ones, in the root AGENTS.md block', () => {
    const block = renderLaunchRuleIndex(model(rule('.claude/rules/02-gates.md', null), scoped));
    expect(block).toContain('- `.claude/rules/02-gates.md`: Title');
    expect(block).not.toContain('36-cli.md');
  });
});

describe('checkRuleReferencesInSource', () => {
  const scoped = rule('.claude/rules/50-row-isolation.md', "paths:\n  - 'apps/api/**'");
  const launch = rule('.claude/rules/02-gates.md', null);
  const m = model(scoped, launch);

  it('extracts full rule file names and ignores short references', () => {
    const text = '// see `.claude/rules/50-row-isolation.md` and .claude/rules/50.\n';
    expect(ruleFilesNamedIn(text)).toEqual(['.claude/rules/50-row-isolation.md']);
  });

  it('flags source that names a rule which does not load for it', () => {
    const findings = checkRuleReferencesInSource(m, [
      {
        file: 'packages/worker-core/src/row-parsing.ts',
        ruleFile: '.claude/rules/50-row-isolation.md',
      },
    ]);
    expect(findings.map((f) => f.check)).toEqual(['rule-reference-not-covered']);
  });

  it('passes for covered files, launch rules and names that are not rule files', () => {
    expect(
      checkRuleReferencesInSource(m, [
        { file: 'apps/api/src/a.ts', ruleFile: '.claude/rules/50-row-isolation.md' },
        { file: 'packages/ui/src/a.tsx', ruleFile: '.claude/rules/02-gates.md' },
        { file: 'packages/ui/src/a.tsx', ruleFile: '.claude/rules/99-missing.md' },
      ])
    ).toEqual([]);
  });
});

describe('hardened checks', () => {
  it('flags an unknown hook event, a handler without a type, and disableAllHooks', () => {
    const typo = { hooks: { TypoEvent: [{ hooks: [{}] }] } };
    const messages = checkClaudeHookConfig(typo).map((p) => p.message);
    expect(messages.some((m) => m.includes('not a known Claude Code hook event'))).toBe(true);
    expect(messages.some((m) => m.includes('has no type'))).toBe(true);
    expect(checkClaudeHookConfig({ disableAllHooks: true })).toHaveLength(1);
  });

  it('does not read an empty probe log as agreement', () => {
    const m = model(rule('.claude/rules/02-gates.md', null));
    expect(compareObservedLoads(m, [], []).mismatches).toHaveLength(1);
  });

  it('requires launch entries unless only lazy loads are being compared', () => {
    const scoped = rule('.claude/rules/45-do-mutex.md', "paths:\n  - 'packages/project-data/**'");
    const m = model(scoped);
    const log = parseObservedLog(
      JSON.stringify({
        memory_type: 'Project',
        load_reason: 'path_glob_match',
        file: '.claude/rules/45-do-mutex.md',
        trigger: 'packages/project-data/src/do/index.ts',
      })
    );
    expect(compareObservedLoads(m, log, []).mismatches).toHaveLength(1);
    expect(compareObservedLoads(m, log, [], { lazyOnly: true }).mismatches).toEqual([]);
  });
});

describe('second review round', () => {
  it('does not read a log of only user-level files as agreement', () => {
    // Reported in review: this single line printed "model matches the session".
    const m = model(rule('.claude/rules/02-gates.md', null));
    const log = parseObservedLog(
      JSON.stringify({
        memory_type: 'User',
        load_reason: 'session_start',
        file: '/home/node/.claude/CLAUDE.md',
      })
    );
    expect(compareObservedLoads(m, log, []).mismatches).toHaveLength(1);
    expect(compareObservedLoads(m, log, [], { lazyOnly: true }).mismatches).toHaveLength(1);
  });

  it('flags an unknown handler type and a prompt handler without a prompt', () => {
    const typo = { hooks: { Stop: [{ hooks: [{ type: 'commnad', command: 'x.sh' }] }] } };
    expect(checkClaudeHookConfig(typo)[0].message).toContain('unknown type "commnad"');
    const noPrompt = { hooks: { Stop: [{ hooks: [{ type: 'prompt' }] }] } };
    expect(checkClaudeHookConfig(noPrompt)[0].message).toContain('has no prompt');
    const fine = { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'Is it done?' }] }] } };
    expect(checkClaudeHookConfig(fine)).toEqual([]);
  });

  it('flags a nested AGENTS.md that no longer fits beside the root one under the Codex cap', () => {
    const sizes = [
      { file: 'AGENTS.md', bytes: 25_000 },
      { file: 'apps/api/AGENTS.md', bytes: 8_000 },
      { file: 'packages/cli/AGENTS.md', bytes: 900 },
    ];
    expect(checkCodexChainSizes(sizes, 32_768).map((f) => f.file)).toEqual(['apps/api/AGENTS.md']);
    expect(checkCodexChainSizes(sizes, 40_000)).toEqual([]);
  });
});

describe('checkRulesLiveAtRoot', () => {
  it('flags a rule file added beside a package, as a concurrent branch on the old layout would', () => {
    const nested = rule('apps/api/.claude/rules/40-sentinel-rows.md', null);
    const root = rule(
      '.claude/rules/40-sentinel-rows.md',
      "paths:\n  - 'apps/api/**'",
      '# Other\n'
    );
    expect(checkRulesLiveAtRoot(model(nested, root)).map((f) => [f.check, f.file])).toEqual([
      ['nested-rule', 'apps/api/.claude/rules/40-sentinel-rows.md'],
    ]);
    expect(checkRulesLiveAtRoot(model(root))).toEqual([]);
  });
});
