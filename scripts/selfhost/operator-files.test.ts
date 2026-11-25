/**
 * operator-files.ts against a real git repository and real umasks (idea 01M89H1MQHJH432BFT2N43GHJJ).
 *
 * git runs in a child shell that sets `umask 077` first, the way the operator's shell did on
 * 2026-11-25: every file a checkout writes then lands 0600. The key agent's build inputs are the
 * files its real Dockerfile copies.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareBackupParent } from './backup-destination.js';
import { encryptBackupTree } from './backup-encryption.js';
import {
  checkoutWithTrackedModes,
  OPERATOR_UMASK,
  restoreTrackedModes,
  useOperatorUmask,
} from './operator-files.js';
import { ensurePrivateDir, replacePrivateFile, writePrivateFile } from './secret-files.js';

const KEY_AGENT_DIR = 'deploy/selfhost/key-agent';

/** The files the key agent image copies (its Dockerfile's COPY line), read from the real file. */
function keyAgentInputs(): string[] {
  const dockerfile = readFileSync(resolve(KEY_AGENT_DIR, 'Dockerfile'), 'utf8');
  const copy = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .find((line) => line.startsWith('COPY '));
  const files = (copy ?? '').split(/\s+/).filter((f) => f.endsWith('.ts'));
  return files.map((f) => `${KEY_AGENT_DIR}/${f}`);
}

let root: string;
let repo: string;
let logs: string[];

/** git in `repo`, run by a shell that first sets the operator's restrictive umask. */
function gitUnderUmask077(command: string, args: string[]) {
  const result = spawnSync('sh', ['-c', 'umask 077; exec "$0" "$@"', command, ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const git = (...args: string[]) => {
  const result = gitUnderUmask077('git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const mode = (path: string) => statSync(join(repo, path)).mode & 0o777;

let inputs: string[];
let oldRef: string;
let newRef: string;

beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'operator-files-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, KEY_AGENT_DIR), { recursive: true });
  logs = [];
  inputs = keyAgentInputs();
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'core.fileMode', 'true');
  for (const path of inputs) writeFileSync(join(repo, path), 'v1\n', { mode: 0o644 });
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  git('add', '-A');
  git('commit', '-qm', 'old');
  oldRef = git('rev-parse', 'HEAD');
  for (const path of inputs) writeFileSync(join(repo, path), 'v2\n');
  writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho v2\n');
  git('add', '-A');
  git('commit', '-qm', 'new');
  newRef = git('rev-parse', 'HEAD');
  git('checkout', '-q', '--detach', oldRef);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('checkoutWithTrackedModes under umask 077', () => {
  it('finds the key agent build inputs (a broken COPY parse cannot pass as "all readable")', () => {
    expect(inputs.length).toBeGreaterThanOrEqual(10);
    expect(inputs).toContain(`${KEY_AGENT_DIR}/bundle-store.ts`);
    expect(inputs).toContain(`${KEY_AGENT_DIR}/server.ts`);
  });

  it('control: a plain checkout under umask 077 leaves the key agent inputs unreadable', () => {
    git('checkout', '-q', '--detach', newRef);
    for (const path of inputs) expect(mode(path)).toBe(0o600);
    expect(mode('run.sh')).toBe(0o700);
  });

  it('upgrade checkout: the key agent inputs are world-readable at their git modes', () => {
    expect(checkoutWithTrackedModes(gitUnderUmask077, newRef, (m) => logs.push(m)).status).toBe(0);
    expect(git('rev-parse', 'HEAD')).toBe(newRef);
    for (const path of inputs) expect(mode(path)).toBe(0o644);
    expect(mode('run.sh')).toBe(0o755);
    expect(logs).toEqual([`restored git file modes on ${inputs.length + 1} tracked paths`]);
  });

  it('rollback checkout: returning to the old ref repairs files a bad upgrade left 0600', () => {
    git('checkout', '-q', '--detach', newRef); // the failed upgrade, without the repair
    expect(checkoutWithTrackedModes(gitUnderUmask077, oldRef, (m) => logs.push(m)).status).toBe(0);
    expect(git('rev-parse', 'HEAD')).toBe(oldRef);
    for (const path of inputs) expect(mode(path)).toBe(0o644);
    expect(mode('run.sh')).toBe(0o755);
  });

  it('makes a directory the target ref adds traversable (git records no directory modes)', () => {
    git('checkout', '-q', '--detach', newRef);
    mkdirSync(join(repo, KEY_AGENT_DIR, 'providers'));
    writeFileSync(join(repo, KEY_AGENT_DIR, 'providers', 'extra.ts'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'adds a directory');
    const withDir = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', oldRef);
    expect(checkoutWithTrackedModes(gitUnderUmask077, withDir, (m) => logs.push(m)).status).toBe(0);
    // Control: git under umask 077 created the directory 0700.
    expect(statSync(join(repo, KEY_AGENT_DIR, 'providers')).mode & 0o777).toBe(0o755);
    expect(mode(`${KEY_AGENT_DIR}/providers/extra.ts`)).toBe(0o644);
  });

  it('control: without the repair, the new directory is 0700', () => {
    git('checkout', '-q', '--detach', newRef);
    mkdirSync(join(repo, KEY_AGENT_DIR, 'providers'));
    writeFileSync(join(repo, KEY_AGENT_DIR, 'providers', 'extra.ts'), 'x\n');
    git('add', '-A');
    git('commit', '-qm', 'adds a directory');
    const withDir = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', oldRef);
    git('checkout', '-q', '--detach', withDir);
    expect(statSync(join(repo, KEY_AGENT_DIR, 'providers')).mode & 0o777).toBe(0o700);
  });

  it('only adds bits: a tracked file a looser umask made 0664 is left as it is', () => {
    git('checkout', '-q', '--detach', newRef);
    const path = `${KEY_AGENT_DIR}/server.ts`;
    chmodSync(join(repo, path), 0o664);
    restoreTrackedModes(gitUnderUmask077);
    expect(mode(path)).toBe(0o664);
  });

  it('leaves untracked files alone (operator state and keys keep their own modes)', () => {
    writeFileSync(join(repo, 'untracked-secret'), 'x', { mode: 0o600 });
    checkoutWithTrackedModes(gitUnderUmask077, newRef, (m) => logs.push(m));
    expect(mode('untracked-secret')).toBe(0o600);
  });

  it('returns a failed checkout without touching modes', () => {
    const result = checkoutWithTrackedModes(gitUnderUmask077, 'f'.repeat(40), (m) => logs.push(m));
    expect(result.status).not.toBe(0);
    expect(logs).toEqual([]);
  });

  it('never follows a symlinked directory out of the repository', () => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'bundle-store.ts'), 'secret\n', { mode: 0o600 });
    rmSync(join(repo, KEY_AGENT_DIR), { recursive: true });
    symlinkSync(outside, join(repo, KEY_AGENT_DIR));
    const repair = restoreTrackedModes(gitUnderUmask077);
    expect(statSync(join(outside, 'bundle-store.ts')).mode & 0o777).toBe(0o600);
    expect(repair.failed).toContain(`${KEY_AGENT_DIR}/bundle-store.ts`);
  });

  it('refuses to report a clean repair when git cannot list the index', () => {
    const broken = () => ({ status: 128, stdout: '', stderr: 'not a git repository' });
    expect(() => restoreTrackedModes(broken)).toThrow(/cannot list the git index/);
  });
});

describe('useOperatorUmask', () => {
  let before: number;
  beforeEach(() => {
    before = process.umask(0o077);
  });
  afterEach(() => {
    process.umask(before);
  });

  it('only loosens: an operator umask looser than 022 is kept', () => {
    process.umask(0o002);
    expect(useOperatorUmask()).toBe(0o002);
    expect(process.umask()).toBe(0o002);
  });

  it('children inherit 022 even when the operator shell had 077', () => {
    expect(useOperatorUmask()).toBe(0o077);
    expect(process.umask()).toBe(OPERATOR_UMASK);
    const child = spawnSync('sh', ['-c', 'umask'], { encoding: 'utf8' });
    expect(child.stdout.trim()).toBe('0022');
    git('checkout', '-q', '--detach', newRef);
    // git here still runs through a shell that sets 077 itself; a child that inherits does not.
    const inherited = spawnSync('git', ['checkout', '-q', '--detach', oldRef], { cwd: repo });
    expect(inherited.status).toBe(0);
    for (const path of inputs) expect(mode(path)).toBe(0o644);
  });
});

// Files that must stay private never rely on the umask: their writers set the mode, so the
// operator umask (and even umask 000) cannot widen them.
describe('private writers under the operator umask', () => {
  let before: number;
  afterEach(() => {
    process.umask(before);
    vi.unstubAllEnvs();
  });

  it.each([
    ['operator umask 022', OPERATOR_UMASK],
    ['umask 000', 0o000],
  ])('state files, state dirs and encrypted backups stay private (%s)', (_name, umask) => {
    for (const name of Object.keys(process.env)) {
      if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
        vi.stubEnv(name, undefined);
    }
    before = process.umask(umask);
    const state = join(root, 'state');
    ensurePrivateDir(state);
    writePrivateFile(join(state, 'secrets.env'), 'A=1\n');
    replacePrivateFile(join(state, 'upgrade-pending.json'), '{}\n');
    const key = join(root, 'backup.key');
    writePrivateFile(key, '');
    writeFileSync(key, Buffer.alloc(32, 7));
    const plain = join(root, 'plain');
    mkdirSync(join(plain, 'state'), { recursive: true, mode: 0o700 });
    writeFileSync(join(plain, 'state', 'platform-keys.json'), '{}', { mode: 0o600 });
    // As runBackup does: missing parents are created private, then the encrypted tree.
    prepareBackupParent(join(root, 'backups', 'snap'));
    encryptBackupTree(plain, join(root, 'backups', 'snap'), key);

    const bits = (path: string) => statSync(path).mode & 0o777;
    expect(bits(state)).toBe(0o700);
    expect(bits(join(state, 'secrets.env'))).toBe(0o600);
    expect(bits(join(state, 'upgrade-pending.json'))).toBe(0o600);
    expect(bits(join(root, 'backups'))).toBe(0o700);
    expect(bits(join(root, 'backups', 'snap'))).toBe(0o700);
    expect(bits(join(root, 'backups', 'snap', 'state'))).toBe(0o700);
    expect(bits(join(root, 'backups', 'snap', 'state', 'platform-keys.json'))).toBe(0o600);
  });
});

// The real entry points, started from a shell with umask 077 the way the 2026-11-25 operator ran
// them. A preload records the process umask when the command exits; each command is given
// arguments that make it stop early, after its entry checks and before it touches anything.
describe('operator entry points', () => {
  const tsx = resolve('node_modules/.bin/tsx');
  const umaskAtExit = (args: string[]) => {
    const record = join(root, 'umask-at-exit');
    const preload = join(root, 'record-umask.cjs');
    // tsx runs the script in a child process: record every process, then pick the script's.
    writeFileSync(
      preload,
      `process.on('exit', () => require('node:fs').appendFileSync(${JSON.stringify(record)}, ` +
        `JSON.stringify({ argv: process.argv.slice(1), umask: process.umask().toString(8) }) + '\\n'));\n`
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => name !== 'CI' && name !== 'GITHUB_ACTIONS' && !name.startsWith('RUNNER_')
      )
    );
    spawnSync('sh', ['-c', 'umask 077; exec "$0" "$@"', tsx, ...args], {
      encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: `--require=${preload}` },
    });
    const lines = readFileSync(record, 'utf8').trim().split('\n');
    const runs = lines.map((l) => JSON.parse(l) as { argv: string[]; umask: string });
    const script = runs.find((r) => r.argv[0] === args[0]) ?? runs[0];
    return script?.umask;
  };
  // An existing env file readable by others: tsx hands `--env-file` to node too (which loads it),
  // and the command then refuses it as not private, right after its entry checks.
  const publicEnv = () => {
    const path = join(root, 'public.env');
    writeFileSync(path, '', { mode: 0o644 });
    return path;
  };

  it('control: the harness observes an inherited umask 077', () => {
    const script = join(root, 'noop.ts');
    writeFileSync(script, 'export {};\n');
    expect(umaskAtExit([script])).toBe('77');
  });

  it.each([
    ['upgrade.ts', () => []],
    ['deploy.ts', () => ['--env-file', publicEnv(), '--dry-run']],
    ['rebuild.ts', () => ['--env-file', publicEnv()]],
    ['restore.ts', () => []],
  ] as const)('%s runs its children with umask 022', (file, args) => {
    expect(umaskAtExit([resolve('scripts/selfhost', file), ...args()])).toBe('22');
  });

  // Rule 61's enumeration: no operator code checks out a ref except through the helper that
  // re-applies git's modes.
  it('every checkout in the operator scripts goes through checkoutWithTrackedModes', () => {
    const sources = readdirSync(resolve('scripts/selfhost')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );
    expect(sources.length).toBeGreaterThan(50);
    const offenders = sources.filter(
      (f) =>
        f !== 'operator-files.ts' &&
        /['"]checkout['"]/.test(readFileSync(resolve('scripts/selfhost', f), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });
});
