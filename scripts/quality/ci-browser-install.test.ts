/**
 * The browser jobs in ci.yml install Chromium with `playwright install --with-deps`, which
 * needs apt. scripts/ci/run-with-apt-mirror-fallback.sh keeps that install working when the
 * runner's own Ubuntu mirrors are unreachable (2026-11-11 Canonical DNS outage).
 *
 * The behaviour tests run the real script. Only the outside world is faked: the installing
 * command, `sudo`, and the process table (`pgrep`/`pkill`). The fake installer decides its
 * exit code from the mirrorlist file the script is expected to rewrite, so a retry that did
 * not really switch mirrors still fails.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { workflowSource } from './workflow-test-helpers';

const HELPER_REPO_PATH = 'scripts/ci/run-with-apt-mirror-fallback.sh';
const HELPER = fileURLToPath(new URL(`../../${HELPER_REPO_PATH}`, import.meta.url));
const DEFAULT_FALLBACK = 'https://mirrors.edge.kernel.org/ubuntu/';
const INSTALL_ARGS = ['install', '--with-deps', 'chromium'];

/** The mirrorlist GitHub ships on hosted Ubuntu runners: three names in one DNS zone. */
const RUNNER_MIRRORLIST = [
  'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1',
  'https://archive.ubuntu.com/ubuntu/\tpriority:2',
  'https://security.ubuntu.com/ubuntu/\tpriority:3',
  '',
].join('\n');

type InstallerMode =
  | 'ok' // the runner's own mirrors work
  | 'needs-fallback' // fails fast (apt exit 100) unless the fallback mirror is first
  | 'hangs-without-fallback' // hangs, leaving apt-get behind, unless the fallback is first
  | 'always-fails'; // nothing works, not even the fallback

interface Sandbox {
  dir: string;
  mirrorlist: string;
  calls: string;
  sudoCalls: string;
  pkillCalls: string;
  aptRunning: string;
  installer: string;
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`);
  chmodSync(path, 0o755);
}

function createSandbox(options: { mirrorlist?: string | null } = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'apt-mirror-fallback-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const sandbox: Sandbox = {
    dir,
    mirrorlist: join(dir, 'apt-mirrors.txt'),
    calls: join(dir, 'installer-calls.log'),
    sudoCalls: join(dir, 'sudo-calls.log'),
    pkillCalls: join(dir, 'pkill-calls.log'),
    aptRunning: join(dir, 'apt-get.running'),
    installer: join(bin, 'fake-playwright'),
  };
  if (options.mirrorlist !== null) {
    writeFileSync(sandbox.mirrorlist, options.mirrorlist ?? RUNNER_MIRRORLIST);
  }

  // Stands in for `playwright install --with-deps chromium`. It succeeds only when apt would:
  // it looks at the mirror apt tries first, the one with the lowest priority number.
  writeExecutable(
    sandbox.installer,
    `printf '%s\\n' "$*" >> "$FAKE_CALLS"
first_mirror=''
if [[ -f "$FAKE_MIRRORLIST" ]]; then
  first_mirror=$(awk '
    /^[ \\t]*(#|$)/ { next }
    {
      priority = 2147483647
      if (match($0, /priority:[0-9]+/)) priority = substr($0, RSTART + 9, RLENGTH - 9) + 0
      if (best == "" || priority < best_priority) { best = $1; best_priority = priority }
    }
    END { print best }
  ' "$FAKE_MIRRORLIST")
fi
case "$FAKE_MODE" in
  ok) exit 0 ;;
  always-fails) exit 100 ;;
  needs-fallback) [[ "$first_mirror" == "$FAKE_FALLBACK" ]] && exit 0; exit 100 ;;
  hangs-without-fallback)
    [[ "$first_mirror" == "$FAKE_FALLBACK" ]] && exit 0
    : > "$FAKE_APT_RUNNING"   # the root-owned apt-get that outlives the timeout
    sleep 60 ;;
esac
`
  );
  // sudo: run the command, and record that it was asked to.
  writeExecutable(join(bin, 'sudo'), `printf '%s\\n' "$*" >> "$FAKE_SUDO_CALLS"\nexec "$@"\n`);
  // pgrep: "is apt-get or dpkg running?" answered from a marker file.
  writeExecutable(join(bin, 'pgrep'), `[[ -e "$FAKE_APT_RUNNING" ]]\n`);
  // pkill: records the request; the process dies unless the test says it is stuck.
  writeExecutable(
    join(bin, 'pkill'),
    `printf '%s\\n' "$*" >> "$FAKE_PKILL_CALLS"\n[[ "\${FAKE_APT_STUCK:-}" == 1 ]] || rm -f -- "$FAKE_APT_RUNNING"\n`
  );
  return sandbox;
}

function runHelper(
  sandbox: Sandbox,
  mode: InstallerMode,
  env: Record<string, string> = {},
  args: string[] = [sandbox.installer, ...INSTALL_ARGS]
) {
  const result = spawnSync('bash', [HELPER, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${join(sandbox.dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: sandbox.dir,
      APT_MIRROR_FALLBACK_MIRRORLIST: sandbox.mirrorlist,
      FAKE_MODE: mode,
      FAKE_FALLBACK: DEFAULT_FALLBACK,
      FAKE_MIRRORLIST: sandbox.mirrorlist,
      FAKE_CALLS: sandbox.calls,
      FAKE_SUDO_CALLS: sandbox.sudoCalls,
      FAKE_PKILL_CALLS: sandbox.pkillCalls,
      FAKE_APT_RUNNING: sandbox.aptRunning,
      ...env,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

const FAST_TIMEOUTS = {
  APT_MIRROR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS: '1',
  APT_MIRROR_FALLBACK_KILL_GRACE_SECONDS: '1',
  APT_MIRROR_FALLBACK_SETTLE_TIMEOUT_SECONDS: '2',
};

describe('run-with-apt-mirror-fallback.sh', () => {
  it('runs the command once and leaves the mirrorlist alone when the runner mirrors work', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'ok');

    expect(result.status, result.output).toBe(0);
    expect(lines(sandbox.calls)).toEqual(['install --with-deps chromium']);
    expect(readFileSync(sandbox.mirrorlist, 'utf8')).toBe(RUNNER_MIRRORLIST);
    expect(lines(sandbox.sudoCalls)).toEqual([]);
  });

  it('reruns the same command with the fallback mirror first when the runner mirrors fail', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'needs-fallback');

    expect(result.status, result.output).toBe(0);
    // The full install ran twice. The second run was not a weaker command.
    expect(lines(sandbox.calls)).toEqual([
      'install --with-deps chromium',
      'install --with-deps chromium',
    ]);
    // Fallback first, then the runner's mirrors in their original order.
    expect(readFileSync(sandbox.mirrorlist, 'utf8')).toBe(
      [
        `${DEFAULT_FALLBACK}\tpriority:1`,
        'http://azure.archive.ubuntu.com/ubuntu/\tpriority:2',
        'https://archive.ubuntu.com/ubuntu/\tpriority:3',
        'https://security.ubuntu.com/ubuntu/\tpriority:4',
        '',
      ].join('\n')
    );
    expect(lines(sandbox.sudoCalls)).toEqual([`tee ${sandbox.mirrorlist}`]);
    expect(result.output).toContain('::warning::First attempt failed (exit 100)');
    expect(result.output).toContain('::warning::Installed through the apt fallback mirror');
  });

  it('stops a hung first attempt, clears the apt-get it left behind, then uses the fallback', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'hangs-without-fallback', FAST_TIMEOUTS);

    expect(result.status, result.output).toBe(0);
    expect(lines(sandbox.calls)).toHaveLength(2);
    expect(result.output).toContain('First attempt failed (timed out after 1s');
    // The leftover apt-get was stopped as root before the mirrorlist was switched.
    expect(lines(sandbox.pkillCalls)).toEqual(['-TERM -x apt-get']);
    expect(lines(sandbox.sudoCalls)).toEqual([
      'pkill -TERM -x apt-get',
      `tee ${sandbox.mirrorlist}`,
    ]);
    expect(existsSync(sandbox.aptRunning)).toBe(false);
  });

  it('fails without a second attempt when the leftover apt-get will not exit', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'hangs-without-fallback', {
      ...FAST_TIMEOUTS,
      FAKE_APT_STUCK: '1',
    });

    expect(result.status, result.output).toBe(124);
    expect(lines(sandbox.calls)).toHaveLength(1);
    expect(readFileSync(sandbox.mirrorlist, 'utf8')).toBe(RUNNER_MIRRORLIST);
    expect(result.output).toContain('apt-get did not exit within 2s');
  });

  it('fails closed when the fallback mirror cannot serve the install either', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'always-fails');

    expect(result.status, result.output).toBe(100);
    // Exactly two attempts, and neither dropped the system dependencies.
    expect(lines(sandbox.calls)).toEqual([
      'install --with-deps chromium',
      'install --with-deps chromium',
    ]);
    expect(result.output).toContain(
      '::error::Second attempt with the fallback mirror also failed (exit 100)'
    );
    expect(result.output).not.toContain('Installed through the apt fallback mirror');
  });

  it('does not retry when the fallback is turned off', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'needs-fallback', { APT_MIRROR_FALLBACK_URLS: 'none' });

    expect(result.status, result.output).toBe(100);
    expect(lines(sandbox.calls)).toHaveLength(1);
    expect(readFileSync(sandbox.mirrorlist, 'utf8')).toBe(RUNNER_MIRRORLIST);
  });

  it('does not retry on an image without an apt mirrorlist', () => {
    const sandbox = createSandbox({ mirrorlist: null });

    const result = runHelper(sandbox, 'needs-fallback');

    expect(result.status, result.output).toBe(100);
    expect(lines(sandbox.calls)).toHaveLength(1);
    expect(existsSync(sandbox.mirrorlist)).toBe(false);
    expect(result.output).toContain('does not exist');
  });

  it('keeps comments and unprioritised mirrors, and puts several fallbacks in the given order', () => {
    const sandbox = createSandbox({
      mirrorlist:
        '# runner mirrors\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\n',
    });
    const second = 'https://mirror.example.org/ubuntu/';

    const result = runHelper(sandbox, 'needs-fallback', {
      APT_MIRROR_FALLBACK_URLS: `${DEFAULT_FALLBACK} ${second}`,
    });

    expect(result.status, result.output).toBe(0);
    expect(readFileSync(sandbox.mirrorlist, 'utf8')).toBe(
      [
        `${DEFAULT_FALLBACK}\tpriority:1`,
        `${second}\tpriority:2`,
        '# runner mirrors',
        'http://azure.archive.ubuntu.com/ubuntu/\tpriority:3',
        'https://archive.ubuntu.com/ubuntu/',
        '',
      ].join('\n')
    );
  });

  it.each([
    ['a plain-http mirror', { APT_MIRROR_FALLBACK_URLS: 'http://mirrors.edge.kernel.org/ubuntu/' }],
    [
      'a mirror carrying extra list metadata',
      { APT_MIRROR_FALLBACK_URLS: 'https://m.example.org/ubuntu/\tpriority:0' },
    ],
    ['a zero timeout', { APT_MIRROR_FALLBACK_ATTEMPT_TIMEOUT_SECONDS: '0' }],
    ['a non-numeric settle timeout', { APT_MIRROR_FALLBACK_SETTLE_TIMEOUT_SECONDS: 'soon' }],
  ])('rejects %s before running anything', (_label, env) => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'ok', env);

    expect(result.status, result.output).toBe(2);
    expect(lines(sandbox.calls)).toEqual([]);
  });

  it('refuses to run without a command', () => {
    const sandbox = createSandbox();

    const result = runHelper(sandbox, 'ok', {}, []);

    expect(result.status, result.output).toBe(2);
    expect(result.output).toContain('usage:');
  });
});

interface CiJob {
  if?: string;
  steps?: Array<{ name?: string; run?: string; with?: { filters?: string } }>;
}

function ciJobs(): Record<string, CiJob> {
  return (parse(workflowSource('ci.yml')) as { jobs: Record<string, CiJob> }).jobs;
}

function ciPathFilters(): Record<string, string[]> {
  const filters = ciJobs()
    .changes?.steps?.map((step) => step.with?.filters)
    .find((value): value is string => typeof value === 'string');
  if (!filters) throw new Error('ci.yml changes job has no paths-filter block');
  return parse(filters) as Record<string, string[]>;
}

const BROWSER_JOBS = ['workspace-quality-surfaces', 'marketing-site', 'playwright-visual'];

describe('ci.yml browser install wiring', () => {
  it('installs Chromium with its system dependencies through the fallback helper in every browser job', () => {
    const jobs = ciJobs();

    const installingJobs = Object.entries(jobs)
      .filter(([, job]) => job.steps?.some((step) => step.run?.includes('playwright install')))
      .map(([name]) => name);
    expect(installingJobs.sort()).toEqual([...BROWSER_JOBS].sort());

    for (const name of BROWSER_JOBS) {
      const installs = (jobs[name]?.steps ?? []).filter((step) =>
        step.run?.includes('playwright install')
      );
      expect(installs, `${name} install steps`).toHaveLength(1);
      expect(installs[0]?.run?.trim(), name).toMatch(
        /^bash \.\.\/\.\.\/scripts\/ci\/run-with-apt-mirror-fallback\.sh \S+( \S+)? install --with-deps chromium$/u
      );
    }
  });

  it('runs every browser job, and the helper tests, when the helper itself changes', () => {
    const filters = ciPathFilters();
    expect(filters['browser-install']).toEqual([HELPER_REPO_PATH]);
    expect(filters['ci-workflow']).toContain(HELPER_REPO_PATH);
    expect(workflowSource('ci.yml')).toContain(
      'browser-install: ${{ steps.filter.outputs.browser-install }}'
    );

    const jobs = ciJobs();
    for (const name of BROWSER_JOBS) {
      expect(jobs[name]?.if, `${name} if`).toContain(
        "needs.changes.outputs.browser-install == 'true'"
      );
    }

    const wiringStep = jobs['ci-workflow']?.steps?.find(
      (step) => step.name === 'Validate CI workflow wiring'
    );
    expect(wiringStep?.run).toContain('ci-browser-install.test.ts');
  });
});
