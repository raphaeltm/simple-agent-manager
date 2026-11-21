/**
 * Pins which CI test suites run for which changes.
 *
 * A suite runs when its package, or any workspace package it depends on, changes. The
 * dependency closure is derived here from every package.json, so a new package, or a
 * new dependency between packages, fails this test until the `changes` job's filters
 * include it. Selection is then checked through the workflow's real job conditions
 * (ci-job-simulator.ts), and the table below is the one quoted in the PR.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  allFilters,
  jobCount,
  loadWorkflow,
  pathFilters,
  type Scenario,
  simulate,
  started,
} from './ci-job-simulator';
import { workflowSource } from './workflow-test-helpers';

const REPO_ROOT = join(__dirname, '..', '..');
const SCOPE = '@simple-agent-manager/';

/** Root files every package's tests read (lockfile, workspace, TypeScript and Vitest bases). */
const ROOT_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.json',
  'vitest.coverage.ts',
];

interface WorkspacePackage {
  name: string;
  dir: string;
  deps: string[];
  hasTests: boolean;
}

function workspacePackages(): Map<string, WorkspacePackage> {
  const { packages: globs } = parse(
    readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
  ) as { packages: string[] };
  const dirs = globs.flatMap((glob) => {
    if (!glob.endsWith('/*')) return [glob];
    const parent = glob.slice(0, -2);
    return readdirSync(join(REPO_ROOT, parent)).map((entry) => `${parent}/${entry}`);
  });
  const found = new Map<string, WorkspacePackage>();
  for (const dir of dirs) {
    const manifest = join(REPO_ROOT, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as Record<string, unknown>;
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap((field) => Object.keys((json[field] as Record<string, string>) ?? {}))
      .filter((dep) => dep.startsWith(SCOPE));
    const scripts = (json.scripts as Record<string, string> | undefined) ?? {};
    found.set(json.name as string, {
      name: json.name as string,
      dir,
      deps,
      hasTests: 'test' in scripts || 'test:coverage' in scripts,
    });
  }
  return found;
}

const PACKAGES = workspacePackages();
const API = `${SCOPE}api`;
const WEB = `${SCOPE}web`;

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (name: string) => {
    const pkg = PACKAGES.get(name);
    if (!pkg) throw new Error(`${name} is not a workspace package`);
    if (seen.has(name)) return;
    seen.add(name);
    pkg.deps.filter((dep) => PACKAGES.has(dep)).forEach(visit);
  };
  roots.forEach(visit);
  return seen;
}

/** Subdirectories of a directory, except the listed ones. */
function subdirsExcept(dir: string, except: string[]): string[] {
  return readdirSync(join(REPO_ROOT, dir))
    .filter((entry) => !except.includes(entry))
    .filter((entry) => statSync(join(REPO_ROOT, dir, entry)).isDirectory())
    .map((entry) => `${dir}/${entry}`);
}

/** Packages `Test other packages` runs: every package with tests except api and web. */
const OTHER_TESTED = [...PACKAGES.values()].filter(
  (pkg) => pkg.hasTests && pkg.name !== API && pkg.name !== WEB
);

/**
 * The suites selected by package. `extra` names workspace directories outside the
 * dependency closure that a suite's tests read or import from, with the reason; the
 * source scan below checks every such read file by file. `scan` is where the suite's
 * test code lives.
 */
const SUITES = [
  {
    output: 'api',
    job: 'durable-object-worker-shards',
    roots: [API],
    extra: {},
    scan: ['apps/api/tests/workers'],
  },
  {
    output: 'api-unit',
    job: 'test-api',
    roots: [API],
    extra: {
      'packages/vm-agent': 'Go sources, Makefile and `go test` runs in contract tests',
      'apps/tail-worker': 'omitted-worker-var defaults scan its sources',
      'apps/web': 'lineage and start-work tests import or read named web modules',
    },
    scan: ['apps/api/tests'],
  },
  {
    output: 'web',
    job: 'test-web',
    roots: [WEB],
    extra: {},
    // Playwright specs run in Playwright Visual Tests (web-ui filter), not here.
    scan: subdirsExcept('apps/web/tests', ['playwright']),
  },
  {
    output: 'public-site',
    job: 'workspace-quality-surfaces',
    roots: [`${SCOPE}www`, `${SCOPE}ui`],
    extra: {},
    scan: [
      'apps/www/src',
      'apps/www/scripts',
      'apps/www/tests/playwright',
      'packages/ui/src',
      'packages/ui/.storybook',
    ],
  },
  {
    output: 'packages',
    job: 'test-packages',
    roots: OTHER_TESTED.map((pkg) => pkg.name),
    extra: { 'apps/web': 'the www integrations catalog test reads the agent sign-in matrix' },
    scan: OTHER_TESTED.map((pkg) => pkg.dir),
  },
] as const;

/** Paths in a suite's closure (and root inputs) its filter does not match. */
function closureGaps(suite: (typeof SUITES)[number], filters = pathFilters()): string[] {
  const probes = [
    ...[...closure([...suite.roots])].flatMap((name) => {
      const { dir } = PACKAGES.get(name)!;
      return [`${dir}/package.json`, `${dir}/src/any/file.ts`];
    }),
    ...ROOT_INPUTS,
  ];
  return probes.filter((path) => !matches(suite.output, path, filters));
}

/** paths-filter glob semantics (picomatch, `dot: true`) for the patterns ci.yml uses. */
function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (glob.startsWith('**/', i)) {
      pattern += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      pattern += '(?:/.*)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      pattern += '.*';
      i += 1;
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  return new RegExp(`^${pattern}$`, 'u');
}

function flatPatterns(filter: string, filters = pathFilters()): string[] {
  const patterns = filters[filter];
  if (!patterns) throw new Error(`missing filter ${filter}`);
  return (patterns as unknown[]).flat(Infinity) as string[];
}

function matches(filter: string, path: string, filters = pathFilters()): boolean {
  return flatPatterns(filter, filters).some((glob) => globToRegExp(glob).test(path));
}

function filtersFor(paths: string[], filters = pathFilters()): string[] {
  return Object.keys(filters).filter((filter) =>
    paths.some((path) => matches(filter, path, filters))
  );
}

const SUITE_JOBS = [
  'test-api',
  'durable-object-worker-shards',
  'test-web',
  'test-packages',
  'workspace-quality-surfaces',
  'playwright-visual',
];

function suitesFor(paths: string[], eventName: Scenario['eventName'] = 'pull_request'): string[] {
  const results = simulate({ eventName, filters: filtersFor(paths) });
  return SUITE_JOBS.filter((job) => results.get(job) === 'success');
}

describe('glob matcher (sanity, so coverage checks cannot pass vacuously)', () => {
  it.each([
    ['apps/api/**', 'apps/api/src/index.ts', true],
    ['apps/api/**', 'apps/api-x/src/index.ts', false],
    ['**/go.mod', 'go.mod', true],
    ['**/go.mod', 'packages/cli/go.mod', true],
    ['scripts/quality/*migration*.ts', 'scripts/quality/check-migration-safety.ts', true],
    ['scripts/quality/*migration*.ts', 'scripts/quality/x/migration.ts', false],
    ['tsconfig.json', 'apps/api/tsconfig.json', false],
  ])('%s matches %s: %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('suite filters follow the package dependency graph', () => {
  it('found the workspace packages (liveness)', () => {
    expect(PACKAGES.size).toBeGreaterThanOrEqual(15);
    expect(PACKAGES.get(API)?.deps).toContain(`${SCOPE}shared`);
  });

  it.each(SUITES.map((suite) => [suite.output, suite] as const))(
    '%s covers every package in its dependency closure and every root input',
    (_, suite) => {
      expect(closureGaps(suite)).toEqual([]);
    }
  );

  it.each(SUITES.map((suite) => [suite.output, suite] as const))(
    '%s names no package outside its closure except its listed extras',
    (_, suite) => {
      const allowed = new Set([
        ...[...closure([...suite.roots])].map((name) => PACKAGES.get(name)!.dir),
        ...Object.keys(suite.extra),
      ]);
      for (const glob of flatPatterns(suite.output)) {
        const dir = /^((?:apps|packages|tools)\/[^/*]+|infra)\//u.exec(glob)?.[1];
        if (!dir) continue;
        expect(existsSync(join(REPO_ROOT, dir)), `${glob} names a missing directory`).toBe(true);
        expect(allowed.has(dir), `${suite.output} lists ${glob}`).toBe(true);
      }
    }
  );

  it('test-packages runs every package except the two apps with their own sharded jobs', () => {
    // The `packages` filter covers each of these (closure test above); this pins the
    // command to the same set, so a package cannot be selected but never tested.
    const packagesStep = loadWorkflow().jobs['test-packages']!.steps!.find(
      (step) => step.name === 'Run package tests with coverage'
    );
    expect(packagesStep?.run).toContain(`--filter='!${API}' --filter='!${WEB}' --concurrency=2`);
    expect(packagesStep?.run?.match(/--filter=/gu)).toHaveLength(2);
  });

  it('a filter that misses a dependency or a root input is caught by the same check', () => {
    const api = SUITES.find((suite) => suite.output === 'api')!;
    const web = SUITES.find((suite) => suite.output === 'web')!;
    const without = (line: string) => {
      const source = workflowSource('ci.yml').replace(`              - '${line}'\n`, '');
      expect(source, line).not.toBe(workflowSource('ci.yml'));
      return pathFilters(loadWorkflow(source));
    };
    // A dependency of apps/api only (repo-hosting) and a dependency of apps/web only (terminal).
    expect(closureGaps(api, without('packages/repo-hosting/**'))).toContain(
      'packages/repo-hosting/package.json'
    );
    expect(closureGaps(web, without('packages/terminal/**'))).toContain(
      'packages/terminal/package.json'
    );
    // The shared root inputs live in one anchor every suite includes.
    expect(closureGaps(web, without('pnpm-lock.yaml'))).toEqual(['pnpm-lock.yaml']);
  });
});

/** The workspace package directory that owns a repo-relative path, else its directory. */
function owningPackageDir(path: string): string {
  const dirs = [...PACKAGES.values()].map((pkg) => pkg.dir);
  const owner = dirs
    .filter((dir) => path === dir || path.startsWith(`${dir}/`))
    .sort((a, b) => b.length - a.length)[0];
  // A file outside every package (a script, a fixture) resolves relative to itself.
  return owner ?? dirname(path);
}

/** Resolves a path the way a read or an import would, or undefined when nothing is there. */
function resolveExisting(candidate: string, imported = false): string | undefined {
  const indexes = imported ? ['/index.ts', '/index.tsx'] : [];
  for (const suffix of ['', '.ts', '.tsx', '.mjs', '.js', '.json', ...indexes]) {
    const path = `${candidate}${suffix}`;
    if (existsSync(path) && (suffix !== '' || statSync(path).isFile())) return path;
  }
  return existsSync(candidate) ? candidate : undefined;
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|astro)$/u;

/**
 * Paths a source file reads or imports. Relative strings resolve against the file,
 * then the package root (for `process.cwd()` joins); `'<apps|packages|tools>/<x>/src'`
 * and segmented joins (`'apps', 'web', 'src', …`) resolve against the repository root;
 * a workspace package import names that
 * package's package.json. Strings that resolve to nothing on disk (fixture text) are
 * dropped. `imported` marks module imports, whose own imports are followed.
 */
function references(file: string): Array<{ path: string; imported: boolean }> {
  const packageDir = owningPackageDir(relative(REPO_ROOT, file));
  const source = readFileSync(file, 'utf8');
  const found: Array<{ path: string | undefined; imported: boolean }> = [];
  for (const match of source.matchAll(
    /(from\s+|import\(\s*)?['"`]((?:\.\.?\/)+[^'"`\s$]*)['"`]/gu
  )) {
    const relativePath = match[2]!;
    const imported = Boolean(match[1]);
    if (!imported && !relativePath.startsWith('../')) continue;
    found.push({
      path: [join(file, '..', relativePath), join(REPO_ROOT, packageDir, relativePath)]
        .map((candidate) => resolveExisting(candidate, imported))
        .find(Boolean),
      imported,
    });
  }
  for (const match of source.matchAll(/['"`]((?:apps|packages|tools)\/[\w-]+\/src)['"`]/gu)) {
    found.push({ path: resolveExisting(join(REPO_ROOT, match[1]!)), imported: false });
  }
  // Segmented joins onto the repository root: read('apps', 'web', 'src', 'X.tsx').
  for (const match of source.matchAll(
    /['"`](apps|packages|scripts|tests|tools|infra)['"`]((?:\s*,\s*['"`][^'"`\s,()]+['"`])+)/gu
  )) {
    const segments = [
      match[1]!,
      ...[...match[2]!.matchAll(/['"`]([^'"`]+)['"`]/gu)].map((m) => m[1]!),
    ];
    found.push({ path: resolveExisting(join(REPO_ROOT, ...segments)), imported: false });
  }
  for (const match of source.matchAll(/from\s+['"](@simple-agent-manager\/[\w-]+)/gu)) {
    const pkg = PACKAGES.get(match[1]!);
    if (pkg) found.push({ path: join(REPO_ROOT, pkg.dir, 'package.json'), imported: false });
  }
  return found.filter((entry): entry is { path: string; imported: boolean } => Boolean(entry.path));
}

/**
 * Files outside the scanned package that its sources read or import. Imports are
 * followed: in-package modules outside the scanned directory (shared test helpers,
 * app sources) and modules imported from other packages are scanned too.
 */
function crossReads(
  dir: string,
  follow: (repoPath: string) => boolean = () => true
): Array<{ file: string; path: string }> {
  const scanned = owningPackageDir(dir);
  const queue: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      if (['node_modules', 'dist', '.astro', '.tmp', 'coverage', 'test-results'].includes(entry))
        continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (CODE_FILE.test(entry)) queue.push(full);
    }
  };
  walk(join(REPO_ROOT, dir));
  const seen = new Set(queue);
  const reads: Array<{ file: string; path: string }> = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const { path, imported } of references(file)) {
      const repoPath = relative(REPO_ROOT, path);
      if (repoPath === '' || repoPath.startsWith('..')) continue;
      // Generated scratch is output, never a checked-in suite input.
      if (repoPath === '.tmp' || repoPath.startsWith('.tmp/')) continue;
      if (repoPath.startsWith(`${scanned}/`)) {
        if (imported && CODE_FILE.test(path) && statSync(path).isFile() && !seen.has(path)) {
          seen.add(path);
          queue.push(path);
        }
        continue;
      }
      const isDirectory = statSync(path).isDirectory();
      reads.push({
        file: relative(REPO_ROOT, file),
        path: isDirectory ? `${repoPath}/x` : repoPath,
      });
      if (imported && !isDirectory && CODE_FILE.test(path) && follow(repoPath) && !seen.has(path)) {
        seen.add(path);
        queue.push(path);
      }
    }
  }
  return reads;
}

function suiteReads(suite: (typeof SUITES)[number]): Array<{ file: string; path: string }> {
  // A module inside a package of the suite's closure is covered with its whole package,
  // and that package's own imports are its declared dependencies, so stop following there.
  const closureDirs = [...closure([...suite.roots])].map((name) => `${PACKAGES.get(name)!.dir}/`);
  return suite.scan.flatMap((dir) =>
    crossReads(dir, (path) => !closureDirs.some((prefix) => path.startsWith(prefix)))
  );
}

describe('every file a suite reads outside its package is in its filter', () => {
  it('runs real git through its dedicated config exactly once in the selected API matrix', () => {
    const job = loadWorkflow().jobs['test-api']!;
    const step = job.steps!.find(
      (entry) => entry.name === 'Hosted git conformance and celld bundle'
    )!;
    expect(job.if).toContain("needs.changes.outputs.api-unit == 'true'");
    expect(step.if).toBe('matrix.shard == 1');
    expect(step.run).toBe('pnpm --filter @simple-agent-manager/api test:hosted-git');
    const buildIndex = job.steps!.findIndex((entry) => entry.name === 'Build API dependencies');
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(job.steps!.findIndex((entry) => entry === step)).toBeGreaterThan(buildIndex);
  });
  it.each(SUITES.map((suite) => [suite.output, suite] as const))(
    '%s',
    (_, suite) => {
      const reads = suiteReads(suite);
      const uncovered = reads
        .filter(({ path }) => !matches(suite.output, path))
        .map(({ path, file }) => `${path} <- ${file}`);
      expect([...new Set(uncovered)].sort()).toEqual([]);
    },
    120_000
  );

  it.each([
    ['api', 'tests/fixtures/diagnostic-secret-canaries.json'],
    ['web', 'tests/fixtures/diagnostic-secret-canaries.json'],
    ['public-site', 'packages/ui/package.json'],
    ['packages', 'apps/web/src/components/AgentSettingsCard.tsx'],
  ])(
    'the %s scan finds %s (liveness)',
    (output, path) => {
      const suite = SUITES.find((candidate) => candidate.output === output)!;
      expect(suiteReads(suite).map((read) => read.path)).toContain(path);
    },
    120_000
  );

  it('finds the known cross-reads (liveness, so an empty scan cannot pass)', () => {
    const apiReads = suiteReads(SUITES.find((suite) => suite.output === 'api-unit')!).map(
      ({ path }) => path
    );
    expect(apiReads.some((path) => path.startsWith('packages/vm-agent/'))).toBe(true);
    expect(apiReads).toContain('apps/tail-worker/src/x');
    expect(apiReads.some((path) => path === '.tmp' || path.startsWith('.tmp/'))).toBe(false);
    expect(apiReads).toContain('scripts/selfhost/celld-binary.ts');
    // Reached only by following a web module's own imports (lineage test -> useTaskGroups).
    expect(apiReads).toContain('apps/web/src/lib/api/client.ts');
    // Without the vm-agent extra the API unit filter would miss them.
    const vmAgentRead = apiReads.find((path) => path.startsWith('packages/vm-agent/'))!;
    expect(matches('api', vmAgentRead)).toBe(false);
    expect(matches('api-unit', vmAgentRead)).toBe(true);
  }, 120_000);
});

/**
 * The selection table quoted in the PR. Suites: test-api (API unit), durable-object-
 * worker-shards (Workers), test-web, test-packages, workspace-quality-surfaces (Storybook
 * and public site), playwright-visual (PR-only, unchanged by this selection).
 */
const TABLE: Array<[string, string[], string[]]> = [
  ['API only', ['apps/api/src/index.ts'], ['test-api', 'durable-object-worker-shards']],
  [
    'API-only package (worker-core)',
    ['packages/worker-core/src/index.ts'],
    ['test-api', 'durable-object-worker-shards', 'test-packages'],
  ],
  ['web only', ['apps/web/src/App.tsx'], ['test-web', 'playwright-visual']],
  [
    'web-only package (terminal)',
    ['packages/terminal/src/index.ts'],
    ['test-web', 'test-packages', 'playwright-visual'],
  ],
  [
    'shared package (packages/shared)',
    ['packages/shared/src/index.ts'],
    ['test-api', 'durable-object-worker-shards', 'test-web', 'test-packages'],
  ],
  [
    'UI package (packages/ui)',
    ['packages/ui/src/index.ts'],
    ['test-web', 'test-packages', 'workspace-quality-surfaces', 'playwright-visual'],
  ],
  [
    'public site or docs (apps/www)',
    ['apps/www/src/content/docs/docs/index.mdx'],
    ['test-packages', 'workspace-quality-surfaces'],
  ],
  ['VM agent (Go)', ['packages/vm-agent/main.go'], ['test-api']],
  [
    'lockfile or root config',
    ['pnpm-lock.yaml'],
    [
      'test-api',
      'durable-object-worker-shards',
      'test-web',
      'test-packages',
      'workspace-quality-surfaces',
    ],
  ],
  ['CI workflow only', ['.github/workflows/ci.yml'], []],
  ['task or spec markdown', ['tasks/backlog/x.md'], []],
];

describe('selection table', () => {
  it.each(TABLE)('a ready PR changing %s runs exactly its suites', (_, paths, suites) => {
    expect(suitesFor(paths)).toEqual(SUITE_JOBS.filter((job) => suites.includes(job)));
  });

  it('a change to any workspace package runs its own suite and every dependent suite', () => {
    for (const pkg of PACKAGES.values()) {
      const ran = suitesFor([`${pkg.dir}/src/probe.ts`]);
      for (const suite of SUITES) {
        if (closure([...suite.roots]).has(pkg.name)) {
          expect(ran, `${pkg.dir} must run ${suite.job}`).toContain(suite.job);
        }
      }
    }
  });

  it('every main push runs every suite except the PR-only visual audit', () => {
    for (const paths of [['tasks/backlog/x.md'], ['apps/www/src/index.ts'], []]) {
      expect(suitesFor(paths, 'push')).toEqual(
        SUITE_JOBS.filter((job) => job !== 'playwright-visual')
      );
    }
  });

  it('a manual dispatch still selects by path (it is not a main push)', () => {
    expect(suitesFor(['apps/web/src/App.tsx'], 'workflow_dispatch')).toEqual(['test-web']);
  });

  it('dropping the main-push override is caught', () => {
    const source = workflowSource('ci.yml').replace(
      "web: ${{ github.event_name == 'push' && 'true' || steps.filter.outputs.web }}",
      'web: ${{ steps.filter.outputs.web }}'
    );
    expect(source).not.toBe(workflowSource('ci.yml'));
    const results = simulate({ eventName: 'push', filters: [] }, loadWorkflow(source));
    expect(results.get('test-web')).toBe('skipped');
  });
});

describe('Test merges only what ran and requires unselected suites to be skipped', () => {
  const step = loadWorkflow().jobs.test!.steps!.find(
    (candidate) => candidate.name === 'Require every selected test shard to pass'
  )!;
  const status = (selected: [string, string, string], results: [string, string, string]) =>
    spawnSync('bash', ['-e', '-c', step.run!], {
      env: {
        ...process.env,
        API_SELECTED: selected[0],
        WEB_SELECTED: selected[1],
        PACKAGES_SELECTED: selected[2],
        API_RESULT: results[0],
        WEB_RESULT: results[1],
        PACKAGES_RESULT: results[2],
      },
    }).status;

  it('passes when every selected suite succeeded and the rest were skipped', () => {
    expect(status(['true', 'true', 'true'], ['success', 'success', 'success'])).toBe(0);
    expect(status(['false', 'true', 'false'], ['skipped', 'success', 'skipped'])).toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])('fails a selected suite that is %s', (bad) => {
    expect(status(['true', 'true', 'true'], [bad, 'success', 'success'])).not.toBe(0);
    expect(status(['true', 'true', 'true'], ['success', bad, 'success'])).not.toBe(0);
    expect(status(['true', 'true', 'true'], ['success', 'success', bad])).not.toBe(0);
  });

  it.each(['failure', 'cancelled', 'success'])(
    'fails an unselected suite that is %s (selection and jobs disagree)',
    (result) => {
      expect(status(['false', 'true', 'true'], [result, 'success', 'success'])).not.toBe(0);
    }
  );

  it("reads each suite's selection and result from the matching job", () => {
    expect(step.env).toEqual({
      API_SELECTED: '${{ needs.changes.outputs.api-unit }}',
      WEB_SELECTED: '${{ needs.changes.outputs.web }}',
      PACKAGES_SELECTED: '${{ needs.changes.outputs.packages }}',
      API_RESULT: '${{ needs.test-api.result }}',
      WEB_RESULT: '${{ needs.test-web.result }}',
      PACKAGES_RESULT: '${{ needs.test-packages.result }}',
    });
    // The suite jobs are gated on the same outputs the step reads.
    const jobs = loadWorkflow().jobs;
    expect(jobs['test-api']!.if).toContain("needs.changes.outputs.api-unit == 'true'");
    expect(jobs['test-web']!.if).toContain("needs.changes.outputs.web == 'true'");
    expect(jobs['test-packages']!.if).toContain("needs.changes.outputs.packages == 'true'");
  });

  it('merges coverage only for the suites that ran', () => {
    const steps = loadWorkflow().jobs.test!.steps!;
    const byName = (name: string) => steps.find((candidate) => candidate.name === name)!;
    expect(byName('Download API blob reports').if).toBe("needs.changes.outputs.api-unit == 'true'");
    expect(byName('Merge API shards and enforce API coverage thresholds').if).toBe(
      "needs.changes.outputs.api-unit == 'true'"
    );
    expect(byName('Download web blob reports').if).toBe("needs.changes.outputs.web == 'true'");
    expect(byName('Merge web shards and enforce web coverage thresholds').if).toBe(
      "${{ !cancelled() && needs.changes.outputs.web == 'true' }}"
    );
  });
});

/**
 * Jobs a ready PR starts, matrix entries counted. GitHub runs at most 20 of the account's
 * jobs at once and queues the rest, so these bound how much one PR queues others.
 * Before this change (main at 3f88f49b2, same simulator): API only 19, web only 16,
 * shared package 19, lockfile 15 (no Workers suite: the old `api` filter had no root
 * inputs), public site or docs 5, API + web + VM agent + docs 23, every filter 27.
 */
describe('runner budget (jobs a ready PR starts)', () => {
  const count = (paths: string[]) =>
    jobCount(simulate({ eventName: 'pull_request', filters: filtersFor(paths) }));

  it.each([
    ['API only', ['apps/api/src/index.ts'], 19],
    ['web only', ['apps/web/src/App.tsx'], 11],
    ['shared package', ['packages/shared/src/index.ts'], 22],
    ['lockfile', ['pnpm-lock.yaml'], 22],
    ['public site or docs', ['apps/www/src/content/docs/docs/index.mdx'], 7],
  ])('a ready %s PR starts the recorded number of jobs', (_, paths, expected) => {
    expect(count(paths)).toBe(expected);
  });

  it('no single-area or shared-package PR starts more than 26 jobs', () => {
    for (const [, paths] of TABLE) expect(count(paths)).toBeLessThanOrEqual(26);
  });

  // Realistic multi-area PRs, with their limits. The four-area shape of baseline run
  // 43734352275 is above 26: 23 before, 27 now. The seventh Workers shard
  // is what brings an API PR to about 10 min, since the Workers shards run alongside the
  // 8.4 min Test api shards.
  it.each([
    [
      'API, web, VM agent and docs',
      [
        'apps/api/src/index.ts',
        'apps/web/src/App.tsx',
        'packages/vm-agent/main.go',
        'apps/www/src/content/docs/docs/index.mdx',
      ],
      27,
    ],
    [
      'shared package and VM agent',
      ['packages/shared/src/index.ts', 'packages/vm-agent/main.go'],
      25,
    ],
    // 27: packages/vm-agent/go.mod also starts Validate Deploy Scripts, whose
    // vm-agent-artifacts.test.ts pins the Go build image to the go directive (a real Go
    // modules PR already did through go.sum).
    [
      'lockfile, VM agent and Go modules',
      ['pnpm-lock.yaml', 'packages/vm-agent/main.go', 'packages/vm-agent/go.mod'],
      27,
    ],
  ])('a ready %s PR starts at most the recorded number of jobs', (_, paths, limit) => {
    expect(count(paths)).toBeLessThanOrEqual(limit);
  });

  // 32: the Self-host Email job (landing plan F12) runs only on self-host email paths.
  // 33: the Self-host Live job (landing plan D9) runs only on self-host paths.
  it('a PR that matches every filter starts at most 33 jobs (27 before: four more Workers shards, Self-host Email, Self-host Live)', () => {
    expect(
      jobCount(simulate({ eventName: 'pull_request', filters: allFilters() }))
    ).toBeLessThanOrEqual(33);
  });

  it('the Self-host Live job starts only for self-host paths (D9)', () => {
    const live = (paths: string[]) =>
      simulate({ eventName: 'pull_request', filters: filtersFor(paths) }).get('selfhost-live');
    for (const path of [
      'deploy/selfhost/caddy/Caddyfile',
      'scripts/selfhost/deploy.ts',
      'apps/api/src/selfhost/build.ts',
    ]) {
      expect(live([path]), path).toBe('success');
    }
    for (const path of [
      'packages/cloud-init/src/reverse-tunnel.ts',
      'apps/api/src/index.ts',
      'packages/worker-core/src/shared-flight.ts',
    ]) {
      expect(live([path]), path).not.toBe('success');
    }
  });

  it('a box file alone starts Validate Deploy Scripts, whose static tests read deploy/selfhost', () => {
    const jobs = (paths: string[]) =>
      simulate({ eventName: 'pull_request', filters: filtersFor(paths) });
    for (const path of [
      'deploy/selfhost/caddy/start.sh',
      'deploy/selfhost/docker-compose.yml',
      'deploy/selfhost/gcp-bootstrap.sh',
    ]) {
      expect(jobs([path]).get('deploy-scripts'), path).toBe('success');
    }
    // Control: a change outside the deploy inputs does not start it.
    expect(jobs(['apps/web/src/main.tsx']).get('deploy-scripts')).not.toBe('success');
  });

  // Its tests import no workspace package, so it builds none (a full API-dependency build was
  // most of its runtime); the tests that need one run in the API unit suite and Self-host Live.
  it('Validate Deploy Scripts builds no workspace package; Self-host Live builds before its type check', () => {
    const steps = (job: string) => loadWorkflow().jobs[job]!.steps!.map((step) => step.run ?? '');
    expect(steps('deploy-scripts').filter((run) => run.includes('turbo run build'))).toEqual([]);
    const live = steps('selfhost-live');
    const build = live.findIndex((run) => run.includes('turbo run build'));
    const typecheck = live.findIndex((run) => run.includes('scripts/selfhost/live/tsconfig.json'));
    expect(build).toBeGreaterThanOrEqual(0);
    expect(typecheck).toBeGreaterThan(build);
  });

  // The access-log redaction guards: the API one runs with the API unit suite, the App.tsx one
  // with the web suite, and either runs when the redaction filter itself changes.
  it('a credential route or the redaction filter selects the suite holding its guard', () => {
    expect(suitesFor(['apps/api/src/routes/bootstrap.ts'])).toContain('test-api');
    expect(suitesFor(['apps/web/src/App.tsx'])).toContain('test-web');
    expect(suitesFor(['deploy/selfhost/caddy/log-redaction.caddy'])).toEqual(
      expect.arrayContaining(['test-api', 'test-web'])
    );
  });

  it('a draft PR starts 6 jobs', () => {
    const results = simulate({ eventName: 'pull_request', draft: true, filters: allFilters() });
    expect(started(results)).toHaveLength(6);
  });
});
