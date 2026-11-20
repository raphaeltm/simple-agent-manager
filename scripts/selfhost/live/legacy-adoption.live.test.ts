/**
 * Legacy adoption (legacy-adoption.ts) against real Docker: a pre-L24 style install under a fixed
 * shared compose project is moved into its canonical project, after which the L24 upgrade
 * preflight that refused it passes. Covers a kill in the middle of a volume copy, a second
 * checkout sharing the project (refused, nothing changed) and a failed health verification
 * (rolled back to the legacy project, data and .env unchanged).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectedComposeProjectFor } from '../install-record.js';
import { runLegacyAdoption } from '../legacy-adoption.js';
import {
  ADOPTION_JOURNAL_FILE,
  type AdoptionJournal,
  readAdoptionJournal,
  writeAdoptionJournal,
} from '../legacy-adoption-journal.js';
import { helperName, returnHelperName } from '../legacy-adoption-volumes.js';
import { readPrivateJson } from '../secret-files.js';
import { UPGRADE_PENDING_FILE } from '../upgrade-journal.js';
import type { BoxContext, UpgradeOptions } from '../upgrade-lib.js';
import { assertRollbackReady } from '../upgrade-preflight.js';
import { childEnv, REPO_ROOT, skipWithoutDocker } from './harness.js';
import {
  ALPINE,
  composeCli,
  containerOf,
  createFixture,
  docker,
  dockerOk,
  fakeBackup,
  FakeGit,
  type Fixture,
  fixtureContext,
  FROM,
  projectHealth,
  readVolumeFile,
  removeProject,
  seedData,
  TO,
} from './legacy-adoption-fixture.js';

let fixture: Fixture;
let canonical: string;
let extraContainers: string[];

function volumesOf(project: string): string[] {
  return docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])
    .stdout.split(/\s+/)
    .filter(Boolean)
    .sort();
}

function canonicalFor(f: Fixture): string {
  const id = readPrivateJson(join(f.stateDir, 'platform-keys.json')).SAM_INSTALLATION_ID ?? '';
  return expectedComposeProjectFor({ SAM_DOMAIN: 'adopt.example.test' }, f.stateDir, id);
}

/** One adoption in its own process group, so the test can SIGKILL it and any child. */
function spawnChild(f: Fixture, healthDelayMs: number, health: 'real' | 'unhealthy' = 'real') {
  return spawn(
    resolve(REPO_ROOT, 'node_modules/.bin/tsx'),
    [
      resolve(import.meta.dirname, 'legacy-adoption-child.ts'),
      JSON.stringify(f),
      String(healthDelayMs),
      health,
    ],
    { cwd: REPO_ROOT, env: childEnv(), stdio: 'ignore', detached: true }
  );
}

describe.skipIf(skipWithoutDocker)('legacy compose adoption (real Docker)', () => {
  beforeAll(() => {
    dockerOk(['pull', '--quiet', ALPINE]);
  });

  beforeEach(() => {
    for (const name of Object.keys(process.env))
      if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
        vi.stubEnv(name, undefined);
    fixture = createFixture();
    canonical = canonicalFor(fixture);
    extraContainers = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const id of extraContainers) docker(['rm', '-f', id]);
    removeProject(canonical);
    removeProject(fixture.legacyProject);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  function adopt(
    git: FakeGit,
    overrides: Partial<Parameters<typeof runLegacyAdoption>[1]> = {},
    logs: string[] = []
  ) {
    return runLegacyAdoption(fixtureContext(fixture, git, logs), {
      to: TO,
      from: FROM,
      checkHealth: projectHealth(fixture),
      backup: fakeBackup([]),
      upgrade: async () => {},
      legacyProject: fixture.legacyProject,
      helperImage: ALPINE,
      checkoutRoot: fixture.root,
      ...overrides,
    });
  }

  it('adopts a legacy install, keeps its data, and then passes the L24 upgrade preflight', async () => {
    seedData(fixture);
    const box = () => fixtureContext(fixture, new FakeGit()).box;
    // The refusal that left pre-L24 installs without an upgrade path (main before this change).
    expect(() => assertRollbackReady({ box: box(), stateDir: fixture.stateDir })).toThrow(
      /missing installation compose creation receipt/
    );
    const backups: string[] = [];
    const upgrades: { project?: string; to: string; head: string; legacyRunning: boolean }[] = [];
    const git = new FakeGit(TO);
    const legacyVolumes = volumesOf(fixture.legacyProject);
    await adopt(git, {
      backup: ((ctx: BoxContext, dest: string) => {
        // The snapshot is taken from the live legacy stack, before anything moves.
        expect(containerOf(fixture.legacyProject, 'celld')).not.toBe('');
        backups.push(`${ctx.box.COMPOSE_PROJECT_NAME}:${dest}`);
      }) as never,
      upgrade: async (ctx: BoxContext, opts: UpgradeOptions) => {
        // The real L24 preflight, against the adopted install's receipts.
        assertRollbackReady(ctx);
        upgrades.push({
          project: ctx.box.COMPOSE_PROJECT_NAME,
          to: opts.to,
          head: git.head,
          legacyRunning: containerOf(fixture.legacyProject, 'celld') !== '',
        });
      },
    });

    expect(backups).toEqual([expect.stringMatching(new RegExp(`^${fixture.legacyProject}:/`))]);
    expect(upgrades).toEqual([{ project: canonical, to: TO, head: FROM, legacyRunning: false }]);
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(
      `${fixture.envText}COMPOSE_PROJECT_NAME=${canonical}\n`
    );
    expect(() => assertRollbackReady({ box: box(), stateDir: fixture.stateDir })).not.toThrow();
    expect(containerOf(canonical, 'celld')).not.toBe('');
    expect(readVolumeFile(`${canonical}_celld-data`, 'do/marker')).toBe('7103:7103:640\ndurable');
    expect(readVolumeFile(`${canonical}_caddy-data`, 'cert.pem')).toBe('0:0:600\ncert');
    expect(
      dockerOk([
        'run',
        '--rm',
        '-v',
        `${canonical}_celld-data:/v:ro`,
        ALPINE,
        'readlink',
        '/v/do/link',
      ])
    ).toBe('marker');
    // Legacy containers are gone; its volumes are kept until the operator removes them.
    expect(
      docker([
        'ps',
        '-aq',
        '--filter',
        `label=com.docker.compose.project=${fixture.legacyProject}`,
      ]).stdout.trim()
    ).toBe('');
    expect(volumesOf(fixture.legacyProject)).toEqual(legacyVolumes);
    expect(readVolumeFile(`${fixture.legacyProject}_celld-data`, 'do/marker')).toContain('durable');
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    // A second run is refused: the install now has its receipt and uses the normal upgrade.
    await expect(adopt(new FakeGit(TO))).rejects.toThrow(
      /COMPOSE_PROJECT_NAME is .*use a normal upgrade/
    );
  });

  it('refuses a legacy project that another checkout also uses, changing nothing', async () => {
    seedData(fixture);
    extraContainers.push(
      dockerOk([
        'run',
        '-d',
        '--label',
        `com.docker.compose.project=${fixture.legacyProject}`,
        '--label',
        'com.docker.compose.service=celld',
        '--label',
        'com.docker.compose.project.working_dir=/srv/another-checkout/deploy/selfhost',
        ALPINE,
        'sleep',
        'infinity',
      ])
    );
    const git = new FakeGit(TO);
    const backups: string[] = [];
    await expect(adopt(git, { backup: fakeBackup(backups) })).rejects.toThrow(
      /belongs to another checkout/
    );
    expect(backups).toEqual([]);
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(fixture.envText);
    expect(containerOf(fixture.legacyProject, 'celld')).not.toBe('');
    expect(volumesOf(canonical)).toEqual([]);
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    expect(git.head).toBe(TO);

    // Control: once the foreign container is gone, the same install is adopted.
    docker(['rm', '-f', ...extraContainers]);
    extraContainers = [];
    await adopt(new FakeGit(TO));
    expect(containerOf(canonical, 'celld')).not.toBe('');
  });

  it('rolls back to the legacy project when health verification fails', async () => {
    seedData(fixture);
    const legacyCelld = containerOf(fixture.legacyProject, 'celld');
    let calls = 0;
    const real = projectHealth(fixture);
    const upgrades: string[] = [];
    const git = new FakeGit(TO);
    await expect(
      adopt(git, {
        checkHealth: async () => {
          if (calls++ > 0) return real();
          // The canonical stack writes before verification fails: none of it may be lost (with
          // `local-store` the bucket itself is such a volume).
          dockerOk([
            'exec',
            containerOf(canonical, 'celld'),
            'sh',
            '-c',
            'echo newer > /var/lib/celld/do/after',
          ]);
          dockerOk([
            'exec',
            containerOf(canonical, 'caddy'),
            'sh',
            '-c',
            'echo renewed > /data/renewed.pem',
          ]);
          return false;
        },
        upgrade: async () => {
          upgrades.push('called');
        },
      })
    ).rejects.toThrow(/not healthy under its canonical compose project/);
    expect(calls).toBe(2);
    expect(upgrades).toEqual([]);
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(fixture.envText);
    expect(containerOf(fixture.legacyProject, 'celld')).toBe(legacyCelld);
    expect(containerOf(canonical, 'celld')).toBe('');
    expect(volumesOf(canonical)).toEqual([]);
    expect(readVolumeFile(`${fixture.legacyProject}_caddy-data`, 'cert.pem')).toBe('0:0:600\ncert');
    // Every canonical volume (the newest state) was carried back over its legacy volume.
    expect(readVolumeFile(`${fixture.legacyProject}_celld-data`, 'do/marker')).toBe(
      '7103:7103:640\ndurable'
    );
    expect(readVolumeFile(`${fixture.legacyProject}_celld-data`, 'do/after')).toContain('newer');
    expect(readVolumeFile(`${fixture.legacyProject}_caddy-data`, 'renewed.pem')).toContain(
      'renewed'
    );
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    expect(git.head).toBe(FROM);
  });

  it('resumes after a kill past the .env switch, then rolls back cleanly on a failed verify', async () => {
    seedData(fixture);
    const child = spawnChild(fixture, 60_000);
    const exited = new Promise((done) => child.on('exit', done));
    let killed = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const journal = existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))
        ? readAdoptionJournal(fixture.stateDir)
        : null;
      if (
        journal?.phase === 'switched' &&
        journal.canonicalStarted &&
        containerOf(canonical, 'celld')
      ) {
        process.kill(-(child.pid as number), 'SIGKILL');
        killed = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    await exited;
    expect(killed).toBe(true);
    expect(readFileSync(fixture.envFile, 'utf8')).toContain(`COMPOSE_PROJECT_NAME=${canonical}`);

    let calls = 0;
    const real = projectHealth(fixture);
    const logs: string[] = [];
    await expect(
      adopt(new FakeGit(FROM), { checkHealth: async () => (calls++ === 0 ? false : real()) }, logs)
    ).rejects.toThrow(/not healthy/);
    expect(logs).toContain('resuming legacy adoption at phase switched');
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(fixture.envText);
    expect(containerOf(fixture.legacyProject, 'celld')).not.toBe('');
    expect(containerOf(canonical, 'celld')).toBe('');
    expect(volumesOf(canonical)).toEqual([]);
    expect(readVolumeFile(`${fixture.legacyProject}_celld-data`, 'do/marker')).toBe(
      '7103:7103:640\ndurable'
    );
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
  });

  it('resumes after the operator process is killed in the middle of a volume copy', async () => {
    seedData(fixture, 4000, 256);
    const child = spawnChild(fixture, 0);
    const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
    const helper = helperName(canonical, 'celld-data');
    let killedMidCopy = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const journal = existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))
        ? readAdoptionJournal(fixture.stateDir)
        : null;
      const cache = journal?.volumes.find((v) => v.suffix === 'celld-data');
      const copying = docker(['ps', '-q', '--filter', `name=^${helper}$`]).stdout.trim() !== '';
      if (cache?.createdAt && !cache.digest && copying) {
        process.kill(-(child.pid as number), 'SIGKILL');
        killedMidCopy = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    await exited;
    expect(killedMidCopy).toBe(true);
    const interrupted = readAdoptionJournal(fixture.stateDir);
    expect(interrupted?.phase).toBe('stopped');
    expect(interrupted?.volumes.find((v) => v.suffix === 'celld-data')?.digest).toBeUndefined();

    // The rerun (same command) removes the orphaned copy helper, recopies and completes.
    const logs: string[] = [];
    await adopt(new FakeGit(FROM), {}, logs);
    expect(logs).toContain('resuming legacy adoption at phase stopped');
    expect(docker(['ps', '-aq', '--filter', `name=^${helper}$`]).stdout.trim()).toBe('');
    expect(readVolumeFile(`${canonical}_celld-data`, 'do/marker')).toBe('7103:7103:640\ndurable');
    const count = (volume: string) =>
      dockerOk([
        'run',
        '--rm',
        '-v',
        `${volume}:/v:ro`,
        ALPINE,
        'sh',
        '-c',
        'ls /v | wc -l; md5sum /v/blob | cut -d" " -f1',
      ]);
    expect(count(`${canonical}_celld-data`)).toBe(count(`${fixture.legacyProject}_celld-data`));
    expect(containerOf(canonical, 'celld')).not.toBe('');
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
  });
  it('finishes an interrupted rollback as a rollback, never resuming forward', async () => {
    seedData(fixture, 4000, 256);
    const child = spawnChild(fixture, 0, 'unhealthy');
    const exited = new Promise((done) => child.on('exit', done));
    const helper = returnHelperName(canonical, 'celld-data');
    let killed = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && child.exitCode === null) {
      const journal = existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))
        ? readAdoptionJournal(fixture.stateDir)
        : null;
      const copying = docker(['ps', '-q', '--filter', `name=^${helper}$`]).stdout.trim() !== '';
      if (journal?.rollingBack && copying) {
        process.kill(-(child.pid as number), 'SIGKILL');
        killed = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    await exited;
    expect(killed).toBe(true);
    expect(readAdoptionJournal(fixture.stateDir)?.rollingBack).toBe(true);

    const upgrades: string[] = [];
    const logs: string[] = [];
    await expect(
      adopt(new FakeGit(TO), { upgrade: async () => void upgrades.push('called') }, logs)
    ).rejects.toThrow(/rolled back after an interrupted rollback/);
    expect(upgrades).toEqual([]);
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(fixture.envText);
    expect(containerOf(fixture.legacyProject, 'celld')).not.toBe('');
    expect(containerOf(canonical, 'celld')).toBe('');
    expect(volumesOf(canonical)).toEqual([]);
    expect(readVolumeFile(`${fixture.legacyProject}_celld-data`, 'do/marker')).toBe(
      '7103:7103:640\ndurable'
    );
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
  });

  it('resumes after a kill between the legacy stop and its journal entry', async () => {
    seedData(fixture);
    let captured: AdoptionJournal | null = null;
    // A first run journals its inventory, then stops at the backup (nothing moved yet).
    await expect(
      adopt(new FakeGit(TO), {
        backup: ((_ctx: BoxContext, dest: string) => {
          captured = readAdoptionJournal(fixture.stateDir);
          mkdirSync(dest, { recursive: true });
          throw new Error('stop here');
        }) as never,
      })
    ).rejects.toThrow(/stop here/);
    expect(captured).not.toBeNull();
    // The state a kill right after `compose stop` leaves: stop intent journaled, phase not yet.
    const journal = captured as unknown as AdoptionJournal;
    writeAdoptionJournal(fixture.stateDir, { ...journal, phase: 'backed-up', stopRequested: true });
    dockerOk(composeCli(fixture, fixture.legacyProject, ['stop']));
    expect(containerOf(fixture.legacyProject, 'celld')).toBe('');

    await adopt(new FakeGit(TO));
    expect(containerOf(canonical, 'celld')).not.toBe('');
    expect(readVolumeFile(`${canonical}_celld-data`, 'do/marker')).toBe('7103:7103:640\ndurable');
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
  });

  it.each([
    ['its own completion flag', 'flag'],
    ["the upgrade's durable completed marker", 'marker'],
  ])('never replays an upgrade that completed before a kill (%s)', async (_name, evidence) => {
    seedData(fixture);
    await expect(
      adopt(new FakeGit(TO), {
        upgrade: async (ctx: BoxContext, opts: UpgradeOptions) => {
          if (evidence === 'flag') opts.onCompleted?.();
          else
            writeFileSync(
              join(ctx.stateDir, UPGRADE_PENDING_FILE),
              JSON.stringify({ from: FROM, to: TO, backupDir: '/x', phase: 'completed' }),
              { mode: 0o600 }
            );
          throw new Error('killed after the upgrade completed');
        },
      })
    ).rejects.toThrow(/killed after the upgrade completed/);

    const replays: string[] = [];
    await adopt(new FakeGit(TO), { upgrade: async () => void replays.push('replayed') });
    expect(replays).toEqual([]);
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    expect(existsSync(join(fixture.stateDir, UPGRADE_PENDING_FILE))).toBe(false);
  });
  it('pulls a missing helper image before changing anything (installs older than the fence)', async () => {
    seedData(fixture);
    // A second pinned image: the fixture's own services keep the default one in use.
    const helper =
      'alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab';
    docker(['image', 'rm', 'alpine:3.21']);
    docker([
      'image',
      'rm',
      'alpine@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab',
    ]);
    expect(docker(['image', 'inspect', helper]).status).not.toBe(0);
    const order: string[] = [];
    const base = fixtureContext(fixture, new FakeGit(TO));
    await runLegacyAdoption(
      {
        ...base,
        run: (command, args, env) => {
          if (command === 'docker') order.push(args.slice(0, 4).join(' '));
          return base.run(command, args, env);
        },
      },
      {
        to: TO,
        from: FROM,
        checkHealth: projectHealth(fixture),
        backup: ((_ctx: BoxContext, dest: string) => {
          order.push('backup');
          mkdirSync(dest, { recursive: true });
        }) as never,
        upgrade: async () => {},
        legacyProject: fixture.legacyProject,
        helperImage: helper,
        checkoutRoot: fixture.root,
      }
    );
    const pull = order.findIndex((line) => line.startsWith('pull '));
    const firstMutation = order.findIndex(
      (line) => line === 'backup' || / stop$/.test(line) || line.startsWith('volume create')
    );
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(pull).toBeLessThan(firstMutation);
    expect(docker(['image', 'inspect', helper]).status).toBe(0);
    expect(readVolumeFile(`${canonical}_celld-data`, 'do/marker')).toBe('7103:7103:640\ndurable');
    expect(containerOf(canonical, 'celld')).not.toBe('');
  });
  it('refuses an unlabelled volume at a canonical name before the backup or the stop', async () => {
    seedData(fixture);
    const legacyCelld = containerOf(fixture.legacyProject, 'celld');
    dockerOk(['volume', 'create', `${canonical}_celld-data`]);
    const backups: string[] = [];
    await expect(adopt(new FakeGit(TO), { backup: fakeBackup(backups) })).rejects.toThrow(
      /exists but was not created by this adoption/
    );
    expect(backups).toEqual([]);
    expect(containerOf(fixture.legacyProject, 'celld')).toBe(legacyCelld);
    expect(readFileSync(fixture.envFile, 'utf8')).toBe(fixture.envText);
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    // The foreign volume is untouched.
    expect(docker(['volume', 'inspect', `${canonical}_celld-data`]).status).toBe(0);
    docker(['volume', 'rm', `${canonical}_celld-data`]);
  });
  it('restarts a legacy celld that a killed backup left stopped, then completes', async () => {
    seedData(fixture);
    let captured: AdoptionJournal | null = null;
    // The backup stops celld for its delta copy; the run dies before it restarts it.
    await expect(
      adopt(new FakeGit(TO), {
        backup: (() => {
          dockerOk(composeCli(fixture, fixture.legacyProject, ['stop', 'celld']));
          captured = readAdoptionJournal(fixture.stateDir);
          throw new Error('backup died with celld stopped');
        }) as never,
      })
    ).rejects.toThrow(/backup died/);
    // A returned failure: celld is running again and nothing else changed.
    expect(containerOf(fixture.legacyProject, 'celld')).not.toBe('');
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    expect((captured as unknown as AdoptionJournal).backupStarted).toBe(true);

    // A kill instead: the journal survives and celld stays stopped.
    writeAdoptionJournal(fixture.stateDir, captured as unknown as AdoptionJournal);
    dockerOk(composeCli(fixture, fixture.legacyProject, ['stop', 'celld']));
    expect(containerOf(fixture.legacyProject, 'celld')).toBe('');
    const backups: string[] = [];
    await adopt(new FakeGit(TO), { backup: fakeBackup(backups) });
    expect(backups).toHaveLength(1);
    expect(containerOf(canonical, 'celld')).not.toBe('');
    expect(readVolumeFile(`${canonical}_celld-data`, 'do/marker')).toBe('7103:7103:640\ndurable');
  });
});
