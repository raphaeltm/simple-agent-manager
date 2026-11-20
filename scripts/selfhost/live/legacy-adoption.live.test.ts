/**
 * Legacy adoption (legacy-adoption.ts) against real Docker: a pre-L24 style install under a fixed
 * shared compose project is moved into its canonical project, after which the L24 upgrade
 * preflight that refused it passes. Covers a kill in the middle of a volume copy, a second
 * checkout sharing the project (refused, nothing changed) and a failed health verification
 * (rolled back to the legacy project, data and .env unchanged).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectedComposeProjectFor } from '../install-record.js';
import { runLegacyAdoption } from '../legacy-adoption.js';
import { ADOPTION_JOURNAL_FILE, readAdoptionJournal } from '../legacy-adoption-journal.js';
import { helperName } from '../legacy-adoption-volumes.js';
import { readPrivateJson } from '../secret-files.js';
import type { BoxContext, UpgradeOptions } from '../upgrade-lib.js';
import { assertRollbackReady } from '../upgrade-preflight.js';
import { childEnv, REPO_ROOT, skipWithoutDocker } from './harness.js';
import {
  ALPINE,
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
        checkHealth: async () => (calls++ === 0 ? false : real()),
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
    // The canonical celld ran, so the disposable legacy cache was emptied (the bucket is durable).
    expect(
      dockerOk([
        'run',
        '--rm',
        '-v',
        `${fixture.legacyProject}_celld-data:/v:ro`,
        ALPINE,
        'ls',
        '-A',
        '/v',
      ])
    ).toBe('');
    expect(existsSync(join(fixture.stateDir, ADOPTION_JOURNAL_FILE))).toBe(false);
    expect(git.head).toBe(FROM);
  });

  it('resumes after the operator process is killed in the middle of a volume copy', async () => {
    seedData(fixture, 4000, 256);
    const child = spawn(
      resolve(REPO_ROOT, 'node_modules/.bin/tsx'),
      [resolve(import.meta.dirname, 'legacy-adoption-child.ts'), JSON.stringify(fixture)],
      { cwd: REPO_ROOT, env: childEnv(), stdio: 'ignore', detached: true }
    );
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
});
