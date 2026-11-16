/**
 * Drives the real Stop hook (.claude/hooks/verify-test-quality.mjs) against fixture git
 * repositories. Each defect Sol's probes found in the old shell script has a case and a
 * control (idea 01M7H8SDG77AE0FH39QXW3NPYX).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = '.claude/hooks/verify-test-quality.mjs';

const repos: string[] = [];

/**
 * The developer's git setup must not reach the fixtures: no inherited GIT_DIR or work tree
 * (inside a git hook they point at the outer repository), no global or system config
 * (commit signing, hooks), and no discovery above the temporary directory.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: realpathSync(tmpdir()),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
  };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
}

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  repos.push(dir);
  return dir;
}

function write(repo: string, path: string, text = 'export const value = 1;\n'): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

/** A repository with the hook installed on `main`, checked out on a feature branch. */
function fixtureRepo(): string {
  const repo = tempDir('stop-gate-');
  git(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, '.claude/hooks'), { recursive: true });
  copyFileSync(join(ROOT, SCRIPT), join(repo, SCRIPT));
  writeFileSync(join(repo, '.gitignore'), '.tmp/\n');
  write(repo, 'apps/api/src/services/existing.ts');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'feature');
  return repo;
}

function commit(repo: string, message = 'change'): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
}

interface HookRun {
  status: number | null;
  output: Record<string, unknown>;
  raw: string;
}

function runHook(repo: string, input: unknown = { session_id: 's1' }): HookRun {
  const result = spawnSync('node', [join(repo, SCRIPT)], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: gitEnv(),
  });
  return { status: result.status, output: JSON.parse(result.stdout), raw: result.stdout };
}

const blocks = (run: HookRun) => run.output.decision === 'block';
const reason = (run: HookRun) => String(run.output.reason ?? '');

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Stop gate: what counts as a change', () => {
  it('ignores a non-code file under a boundary directory (old script blocked on it)', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/no-test-needed.md', '# notes\n');
    commit(repo);
    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(run.output).toEqual({});
  });

  it('control: a boundary source file with no test change is reported', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/new-service.ts');
    commit(repo);
    const run = runHook(repo);
    expect(blocks(run)).toBe(true);
    expect(reason(run)).toContain('apps/api/src/services/new-service.ts');
  });

  it('sees committed branch changes (old script read only `git diff HEAD`)', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/routes/committed.ts');
    commit(repo);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(reason(runHook(repo))).toContain('apps/api/src/routes/committed.ts');
  });

  it('sees untracked files', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/routes/untracked.ts');
    expect(reason(runHook(repo))).toContain('apps/api/src/routes/untracked.ts');
  });

  it('sees staged and unstaged edits', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/existing.ts', 'export const value = 2;\n');
    expect(reason(runHook(repo))).toContain('apps/api/src/services/existing.ts');
    git(repo, 'add', '-A');
    expect(reason(runHook(repo, { session_id: 's2' }))).toContain(
      'apps/api/src/services/existing.ts'
    );
  });

  it('control: committed source with a committed test in its area passes', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/routes/committed.ts');
    write(repo, 'apps/api/tests/unit/routes/committed.test.ts', "it('works', () => {});\n");
    commit(repo);
    expect(runHook(repo).output).toEqual({});
  });

  it('covers ProjectData Durable Object code in packages/project-data/src/do (old pattern missed it)', () => {
    const repo = fixtureRepo();
    write(repo, 'packages/project-data/src/do/session-sockets.ts');
    commit(repo);
    expect(reason(runHook(repo))).toContain('packages/project-data/src/do/session-sockets.ts');
  });

  it('control: a worker package change is covered by its own tests or by apps/api tests', () => {
    const repo = fixtureRepo();
    write(repo, 'packages/project-data/src/do/session-sockets.ts');
    write(repo, 'packages/project-data/tests/unit/session-sockets.test.ts', "it('x', () => {});\n");
    commit(repo);
    expect(runHook(repo).output).toEqual({});

    const second = fixtureRepo();
    write(second, 'packages/operations/src/ideas.ts');
    write(second, 'apps/api/tests/workers/ideas.test.ts', "it('x', () => {});\n");
    commit(second);
    expect(runHook(second).output).toEqual({});
  });

  it('does not treat a test in another package as covering the change', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/thing.ts');
    write(repo, 'apps/web/tests/unit/thing.test.ts', "it('x', () => {});\n");
    commit(repo);
    expect(reason(runHook(repo))).toContain('apps/api/src/services/thing.ts');
  });
});

describe('Stop gate: delivery and loop safety', () => {
  it('delivers feedback even when stop_hook_active is true (old script approved unconditionally)', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/new-service.ts');
    commit(repo);
    const run = runHook(repo, { session_id: 'loop', stop_hook_active: true });
    expect(blocks(run)).toBe(true);
  });

  it('feedback is delivered once per set of findings, then the turn may end', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/new-service.ts');
    commit(repo);
    expect(blocks(runHook(repo, { session_id: 'once' }))).toBe(true);
    const second = runHook(repo, { session_id: 'once', stop_hook_active: true });
    expect(blocks(second)).toBe(false);
    expect(String(second.output.systemMessage)).toContain('untested-boundary-change');
    // A new finding in the same session is delivered again.
    write(repo, 'apps/api/src/services/another.ts');
    expect(blocks(runHook(repo, { session_id: 'once', stop_hook_active: true }))).toBe(true);
  });

  it('a blocking class repeats while unresolved, but never more than the limit', () => {
    const repo = fixtureRepo();
    const shallow = [
      'vi.fn().mockResolvedValue({});',
      'vi.fn().mockResolvedValue({});',
      'vi.fn().mockReturnValue({});',
      'vi.fn().mockReturnValue({});',
    ].join('\n');
    write(repo, 'apps/api/tests/unit/shallow.test.ts', `${shallow}\n`);
    commit(repo);
    const results = [1, 2, 3, 4, 5].map(() =>
      blocks(runHook(repo, { session_id: 'cap', stop_hook_active: true }))
    );
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('control: a test with realistic state is not reported as shallow', () => {
    const repo = fixtureRepo();
    const realistic = [
      'vi.fn().mockResolvedValue({});',
      'vi.fn().mockResolvedValue({});',
      'vi.fn().mockResolvedValue({});',
      "vi.fn().mockResolvedValue({ id: 'ws-1', status: 'running' });",
    ].join('\n');
    write(repo, 'apps/api/tests/unit/realistic.test.ts', `${realistic}\n`);
    commit(repo);
    expect(runHook(repo).output).toEqual({});
  });
});

describe('Stop gate: output contract and failure safety', () => {
  it('prints only documented fields: {} to allow, decision "block" with a reason to continue', () => {
    const clean = fixtureRepo();
    const allow = runHook(clean);
    expect(allow.output).toEqual({});
    expect(allow.raw).not.toContain('approve');

    const dirty = fixtureRepo();
    write(dirty, 'apps/api/src/routes/x.ts');
    const block = runHook(dirty);
    expect(Object.keys(block.output).sort()).toEqual(['decision', 'reason']);
    expect(block.output.decision).toBe('block');
  });

  it('exits 0 with valid JSON for thousands of changed files (old script could exit 141)', () => {
    const repo = fixtureRepo();
    for (let index = 0; index < 3000; index++)
      write(repo, `apps/api/src/services/gen/f${index}.ts`);
    const run = runHook(repo);
    expect(run.status).toBe(0);
    expect(blocks(run)).toBe(true);
    expect(reason(run)).toContain('+2985 more');
  });

  it('exits 0 with {} on malformed input or outside a git repository', () => {
    const repo = fixtureRepo();
    const malformed = runHook(repo, 'not json');
    expect(malformed.status).toBe(0);
    expect(malformed.output).toEqual({});

    const notRepo = tempDir('stop-gate-norepo-');
    mkdirSync(join(notRepo, '.claude/hooks'), { recursive: true });
    copyFileSync(join(ROOT, SCRIPT), join(notRepo, SCRIPT));
    const outside = runHook(notRepo);
    expect(outside.status).toBe(0);
    expect(outside.output).toEqual({});
  });

  it('uses only Node built-ins, so it runs without node_modules', () => {
    const source = readFileSync(join(ROOT, SCRIPT), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith('node:'))).toBe(true);
  });
});

describe('Stop gate: which base the branch is compared with', () => {
  it('reports only the branch changes when main moved on after the branch point', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/on-branch.ts');
    commit(repo, 'branch work');
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'apps/api/src/services/on-main.ts');
    // A two-dot diff against main would report this edit as a branch change.
    write(repo, 'apps/api/src/services/existing.ts', 'export const value = 2;\n');
    commit(repo, 'main moved');
    git(repo, 'checkout', '-q', 'feature');
    const text = reason(runHook(repo));
    expect(text).toContain('apps/api/src/services/on-branch.ts');
    expect(text).not.toContain('on-main.ts');
    expect(text).not.toContain('existing.ts');
  });

  it('prefers origin/main over a stale local main', () => {
    const repo = fixtureRepo();
    // origin/main has a commit the stale local main lacks; the branch starts from it.
    git(repo, 'checkout', '-q', '-b', 'upstream', 'main');
    write(repo, 'apps/api/src/services/upstream-only.ts');
    commit(repo, 'upstream work');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'topic');
    write(repo, 'apps/api/src/services/topic.ts');
    commit(repo, 'topic work');
    const text = reason(runHook(repo));
    expect(text).toContain('apps/api/src/services/topic.ts');
    expect(text).not.toContain('upstream-only.ts');
  });

  it('without a known default branch it falls back to uncommitted work only', () => {
    const repo = fixtureRepo();
    git(repo, 'branch', '-m', 'main', 'trunk');
    write(repo, 'apps/api/src/services/committed.ts');
    commit(repo);
    write(repo, 'apps/api/src/services/untracked.ts');
    const text = reason(runHook(repo));
    expect(text).toContain('apps/api/src/services/untracked.ts');
    expect(text).not.toContain('committed.ts');
  });
});

describe('Stop gate: classification edges', () => {
  it('does not report a deleted boundary file', () => {
    const repo = fixtureRepo();
    git(repo, 'rm', '-q', 'apps/api/src/services/existing.ts');
    commit(repo);
    const run = runHook(repo);
    expect(run.output).toEqual({});
    // Liveness: the same repository still reports an added file.
    write(repo, 'apps/api/src/services/added.ts');
    expect(blocks(runHook(repo, { session_id: 's-live' }))).toBe(true);
  });

  it.each([
    ['apps/web/src/hooks/useThing.ts', 'apps/web/tests/unit/useThing.test.ts'],
    ['apps/web/src/lib/api/things.ts', 'apps/web/src/lib/api/things.test.ts'],
    [
      'packages/vm-agent/internal/server/thing.go',
      'packages/vm-agent/internal/server/thing_test.go',
    ],
    ['apps/api/src/durable-objects/thing.ts', 'apps/api/tests/workers/thing.test.ts'],
    ['apps/api/src/scheduled/thing.ts', 'apps/api/tests/unit/thing.test.ts'],
  ])('%s is boundary code, covered by %s', (source, test) => {
    const repo = fixtureRepo();
    write(repo, source);
    commit(repo);
    expect(reason(runHook(repo))).toContain(source);
    write(repo, test);
    commit(repo);
    expect(runHook(repo, { session_id: 's-covered' }).output).toEqual({});
  });

  it('ignores declaration files and non-boundary source', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/types.d.ts');
    write(repo, 'apps/api/src/lib/helper.ts');
    commit(repo);
    expect(runHook(repo).output).toEqual({});
  });

  it('a shallow test needs more than two empty mocks', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/tests/unit/two.test.ts', 'vi.fn().mockResolvedValue({});\n'.repeat(2));
    commit(repo);
    expect(runHook(repo).output).toEqual({});
    write(repo, 'apps/api/tests/unit/three.test.ts', 'vi.fn().mockResolvedValue({});\n'.repeat(3));
    expect(reason(runHook(repo, { session_id: 's-three' }))).toContain('three.test.ts');
  });

  it('delivers feedback again after the findings were cleared and came back', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/thing.ts');
    commit(repo);
    expect(blocks(runHook(repo, { session_id: 'cycle' }))).toBe(true);
    write(repo, 'apps/api/tests/unit/thing.test.ts');
    commit(repo);
    expect(runHook(repo, { session_id: 'cycle' }).output).toEqual({});
    git(repo, 'rm', '-q', 'apps/api/tests/unit/thing.test.ts');
    commit(repo);
    expect(blocks(runHook(repo, { session_id: 'cycle' }))).toBe(true);
  });

  it('a mix of feedback and blocking findings blocks up to the limit', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/thing.ts');
    write(
      repo,
      'apps/web/tests/unit/shallow.test.ts',
      'vi.fn().mockResolvedValue({});\n'.repeat(3)
    );
    commit(repo);
    const results = [1, 2, 3, 4].map(() => blocks(runHook(repo, { session_id: 'mixed' })));
    expect(results).toEqual([true, true, true, false]);
  });
});

describe('Stop gate: never traps or breaks a session', () => {
  it('lets the turn end when its state cannot be saved', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/thing.ts');
    commit(repo);
    // A file where the state directory should be makes every write fail.
    mkdirSync(join(repo, '.tmp'), { recursive: true });
    writeFileSync(join(repo, '.tmp/stop-gate'), 'not a directory');
    const runs = [1, 2, 3].map(() => runHook(repo, { session_id: 'readonly' }));
    for (const run of runs) {
      expect(run.status).toBe(0);
      expect(blocks(run)).toBe(false);
      expect(String(run.output.systemMessage)).toContain('could not save its state');
    }
  });

  it('skips a test file that is a symlink to an endless device', () => {
    const repo = fixtureRepo();
    mkdirSync(join(repo, 'apps/api/tests'), { recursive: true });
    symlinkSync('/dev/zero', join(repo, 'apps/api/tests/zero.test.ts'));
    write(repo, 'apps/api/src/services/thing.ts');
    const run = runHook(repo);
    expect(run.status).toBe(0);
    // Liveness: the hook still evaluated the branch (the symlink counts as a test change).
    expect(run.output).toEqual({});
    expect(readdirSync(join(repo, '.tmp/stop-gate'))).toEqual(['s1.json']);
  });

  it('keeps state for a very long session id inside the state directory', () => {
    const repo = fixtureRepo();
    write(repo, 'apps/api/src/services/thing.ts');
    commit(repo);
    const id = `../${'x'.repeat(400)}`;
    expect(blocks(runHook(repo, { session_id: id }))).toBe(true);
    expect(blocks(runHook(repo, { session_id: id }))).toBe(false);
    const [file] = readdirSync(join(repo, '.tmp/stop-gate'));
    expect(file?.length).toBeLessThan(120);
  });
});
