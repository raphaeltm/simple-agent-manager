/**
 * Legacy adoption units: the journal refuses records it did not write, .env rewriting keeps every
 * other byte, and the ownership proof refuses each ambiguous shape. The end-to-end behaviour on
 * real Docker is in live/legacy-adoption.live.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runLegacyAdoption } from './legacy-adoption.js';
import { proveLegacyOwnership } from './legacy-adoption-inventory.js';
import {
  ADOPTION_JOURNAL_FILE,
  type AdoptionJournal,
  envWithProject,
  readAdoptionJournal,
  saveOriginalEnv,
  writeAdoptionJournal,
} from './legacy-adoption-journal.js';
import { DEFAULT_ADOPTION_HELPER_IMAGE, ensureHelperImage } from './legacy-adoption-volumes.js';
import { completeUpgradeJournal, upgradeCompletedTo } from './upgrade-journal.js';
import type { RunResult } from './upgrade-lib.js';

let root: string;
beforeEach(() => {
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'sam-adoption-'));
  mkdirSync(join(root, 'deploy/selfhost/.state'), { recursive: true, mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const state = () => join(root, 'deploy/selfhost/.state');
const journal = (overrides: Partial<AdoptionJournal> = {}): AdoptionJournal => ({
  version: 1,
  adoptionId: 'a'.repeat(32),
  from: 'f'.repeat(40),
  to: 'e'.repeat(40),
  legacyProject: 'sam-selfhost',
  canonicalProject: 'sam-selfhost-0123456789ab',
  installationId: 'b'.repeat(32),
  phase: 'stopped',
  legacyContainers: ['c'.repeat(64)],
  volumes: [
    {
      suffix: 'celld-data',
      legacy: 'sam-selfhost_celld-data',
      canonical: 'sam-selfhost-0123456789ab_celld-data',
    },
  ],
  canonicalStarted: false,
  ...overrides,
});

describe('adoption journal', () => {
  it('round-trips a valid record', () => {
    writeAdoptionJournal(state(), journal());
    expect(readAdoptionJournal(state())).toEqual(journal());
  });

  it.each([
    ['an unknown phase', { phase: 'copying' }],
    ['a short --from', { from: 'f'.repeat(12) }],
    [
      'a volume of another project',
      {
        volumes: [{ suffix: 'x', legacy: 'other_x', canonical: 'sam-selfhost-0123456789ab_x' }],
      },
    ],
    ['identical projects', { canonicalProject: 'sam-selfhost' }],
    ['a relative backup path', { backupDir: 'backups/x' }],
  ])('refuses %s', (_name, overrides) => {
    writeAdoptionJournal(state(), journal(overrides as Partial<AdoptionJournal>));
    expect(() => readAdoptionJournal(state())).toThrow(/not a legacy adoption record/);
  });

  it('refuses a group-readable record', () => {
    writeFileSync(join(state(), ADOPTION_JOURNAL_FILE), JSON.stringify(journal()), { mode: 0o644 });
    expect(() => readAdoptionJournal(state())).toThrow(/readable by group or others/);
  });

  it('keeps the first original .env across resumed runs', () => {
    const env = join(root, 'deploy/selfhost/.env');
    writeFileSync(env, 'A=1\n', { mode: 0o600 });
    saveOriginalEnv(state(), env);
    writeFileSync(env, 'A=1\nCOMPOSE_PROJECT_NAME=x\n', { mode: 0o600 });
    saveOriginalEnv(state(), env);
    expect(readFileSync(join(state(), 'legacy-adoption.env'), 'utf8')).toBe('A=1\n');
  });
});

describe('envWithProject', () => {
  it('appends the project and keeps every other byte', () => {
    expect(envWithProject('# c\nA=1\n', 'p')).toBe('# c\nA=1\nCOMPOSE_PROJECT_NAME=p\n');
    expect(envWithProject('A=1', 'p')).toBe('A=1\nCOMPOSE_PROJECT_NAME=p\n');
  });
  it('replaces an explicit legacy name instead of adding a second one', () => {
    expect(envWithProject('COMPOSE_PROJECT_NAME=sam-selfhost\nA=1\n', 'p')).toBe(
      'A=1\nCOMPOSE_PROJECT_NAME=p\n'
    );
  });
});

describe('proveLegacyOwnership', () => {
  const ID = 'd'.repeat(64);
  const HASH = '9'.repeat(64);
  let mounts: { Type: string; Name?: string; Source?: string }[];
  let volumeUsers: string[];
  let hash: string;

  const ctx = () => {
    const dir = join(root, 'deploy/selfhost');
    const run = (_command: string, args: string[]): RunResult => {
      const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
      if (args[0] === 'ps' && args.includes('label=com.docker.compose.project=sam-selfhost'))
        return ok(`${ID}\n`);
      if (args[0] === 'ps') return ok(volumeUsers.join('\n'));
      if (args[0] === 'inspect')
        return ok(
          JSON.stringify([
            {
              Id: ID,
              State: { Running: true },
              Config: {
                Labels: {
                  'com.docker.compose.project': 'sam-selfhost',
                  'com.docker.compose.service': 'celld',
                  'com.docker.compose.config-hash': hash,
                  'com.docker.compose.project.working_dir': dir,
                  'com.docker.compose.project.config_files': join(dir, 'docker-compose.yml'),
                  'com.docker.compose.project.environment_file': join(dir, '.env'),
                },
              },
              Mounts: mounts,
            },
          ])
        );
      if (args[0] === 'volume' && args[1] === 'ls') return ok('sam-selfhost_celld-data\n');
      return ok(
        JSON.stringify([
          {
            Labels: {
              'com.docker.compose.project': 'sam-selfhost',
              'com.docker.compose.volume': 'celld-data',
            },
          },
        ])
      );
    };
    return {
      run,
      envFile: join(dir, '.env'),
      stateDir: join(dir, '.state'),
      composeFiles: [join(dir, 'docker-compose.yml')],
    };
  };
  const prove = () =>
    proveLegacyOwnership(ctx(), {
      legacyProject: 'sam-selfhost',
      checkoutRoot: root,
      configHashOutput: `celld ${HASH}\n`,
      requireRunningCelld: true,
    });

  beforeEach(() => {
    mounts = [
      { Type: 'volume', Name: 'sam-selfhost_celld-data' },
      { Type: 'bind', Source: join(root, 'deploy/selfhost/celld/start.sh') },
      { Type: 'bind', Source: join(root, 'deploy/selfhost/.state/egress-fence.nft') },
    ];
    volumeUsers = [ID];
    hash = HASH;
  });

  it("accepts this checkout's legacy stack (control)", () => {
    expect(prove()).toEqual({
      containers: [{ id: ID, service: 'celld', running: true }],
      volumes: [{ suffix: 'celld-data', name: 'sam-selfhost_celld-data' }],
    });
  });
  it("refuses a stack whose config hash is not --from's", () => {
    hash = '8'.repeat(64);
    expect(prove).toThrow(/does not match the --from compose configuration/);
  });
  it('refuses a bind mount outside the checkout and state directory', () => {
    mounts.push({ Type: 'bind', Source: '/srv/elsewhere/data' });
    expect(prove).toThrow(/outside this checkout/);
  });
  it('refuses a volume another container also uses', () => {
    volumeUsers = [ID, 'e'.repeat(64)];
    expect(prove).toThrow(/also used elsewhere/);
  });
  it('refuses a volume of another project', () => {
    mounts.push({ Type: 'volume', Name: 'other_data' });
    expect(prove).toThrow(/volume of another project/);
  });
});

describe('runLegacyAdoption argument guards', () => {
  const FROM = 'f'.repeat(40);
  const TO = 'e'.repeat(40);
  let head: string;
  let dirty: boolean;
  let docker: string[];

  const ctx = () => {
    const dir = join(root, 'deploy/selfhost');
    writeFileSync(join(dir, '.env'), 'SAM_DOMAIN=x.test\n', { mode: 0o600 });
    return {
      box: { SAM_DOMAIN: 'x.test' } as Record<string, string>,
      envFile: join(dir, '.env'),
      stateDir: state(),
      composeFiles: [join(dir, 'docker-compose.yml')],
      log: () => {},
      run: (command: string, args: string[]): RunResult => {
        const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
        if (command === 'docker') {
          docker.push(args.join(' '));
          return { status: 1, stdout: '', stderr: 'docker must not run' };
        }
        if (args[0] === 'status') return ok(dirty ? ' M x.ts' : '');
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(head);
        if (args[0] === 'rev-parse') return ok(args[2]?.startsWith('main') ? TO : 'c'.repeat(40));
        return ok();
      },
    };
  };
  const adopt = (overrides: { from?: string; to?: string } = {}) =>
    runLegacyAdoption(ctx(), {
      from: overrides.from ?? FROM,
      to: overrides.to ?? 'main',
      checkHealth: async () => true,
      upgrade: async () => {},
    });

  beforeEach(() => {
    for (const name of Object.keys(process.env))
      if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
        vi.stubEnv(name, undefined);
    vi.stubEnv('COMPOSE_PROJECT_NAME', undefined);
    head = TO;
    dirty = false;
    docker = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    // Every refusal happens before any container, volume or compose command.
    expect(docker).toEqual([]);
  });

  it('refuses an abbreviated --from', async () => {
    await expect(adopt({ from: 'f'.repeat(12) })).rejects.toThrow(/full 40-character/);
  });
  it('refuses a shell COMPOSE_PROJECT_NAME', async () => {
    vi.stubEnv('COMPOSE_PROJECT_NAME', 'sam-selfhost');
    await expect(adopt()).rejects.toThrow(/Unset COMPOSE_PROJECT_NAME/);
  });
  it('refuses a dirty checkout', async () => {
    dirty = true;
    await expect(adopt()).rejects.toThrow(/uncommitted changes/);
  });
  it('refuses to run from the deployed commit itself', async () => {
    head = FROM;
    await expect(adopt()).rejects.toThrow(/check out the target SAM ref first/);
  });
  it('refuses a --to that is not the checked-out target', async () => {
    await expect(adopt({ to: 'v2026.11.19' })).rejects.toThrow(/check out v2026.11.19 first/);
  });
  it('refuses to resume an adoption with a different --from', async () => {
    writeAdoptionJournal(state(), journal());
    await expect(adopt({ from: 'a'.repeat(40) })).rejects.toThrow(/pass the same --from/);
  });
  it('removes a leftover .env copy identical to .env (a kill between the two removals)', async () => {
    writeFileSync(join(state(), 'legacy-adoption.env'), 'SAM_DOMAIN=x.test\n', { mode: 0o600 });
    // It gets past the copy to the next precondition, which this fixture lacks.
    await expect(adopt()).rejects.toThrow(/no platform-keys.json/);
    expect(existsSync(join(state(), 'legacy-adoption.env'))).toBe(false);
  });
  it('refuses an orphaned .env copy left without its journal', async () => {
    writeFileSync(join(state(), 'legacy-adoption.env'), 'A=1\n', { mode: 0o600 });
    await expect(adopt()).rejects.toThrow(/exists without its journal/);
  });
});

describe('adoption helper image', () => {
  it('is the egress fence base image, pinned by digest', () => {
    const dockerfile = readFileSync(resolve('deploy/selfhost/egress-fence/Dockerfile'), 'utf8');
    const base = /^FROM\s+(\S+)/m.exec(dockerfile)?.[1];
    expect(DEFAULT_ADOPTION_HELPER_IMAGE).toBe(base);
    expect(DEFAULT_ADOPTION_HELPER_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
  });
  it('is pulled before any change when it is not present locally', () => {
    const calls: string[] = [];
    ensureHelperImage(
      {
        run: (_c, args) => {
          calls.push(args.slice(0, 2).join(' '));
          return { status: args[0] === 'image' ? 1 : 0, stdout: '', stderr: '' };
        },
      },
      DEFAULT_ADOPTION_HELPER_IMAGE
    );
    expect(calls).toEqual(['image inspect', 'pull --quiet']);
  });
});

describe('upgrade completion marker', () => {
  it('is durable while the completion hook runs, then cleared', () => {
    let seen = false;
    completeUpgradeJournal(
      state(),
      { from: 'f'.repeat(40), to: 'e'.repeat(40), backupDir: '/b' },
      () => {
        seen = upgradeCompletedTo(state(), 'e'.repeat(40));
      }
    );
    expect(seen).toBe(true);
    expect(upgradeCompletedTo(state(), 'e'.repeat(40))).toBe(false);
  });
  it('does not count a recovery to the previous version as an upgrade', () => {
    let seen = true;
    completeUpgradeJournal(
      state(),
      { from: 'f'.repeat(40), to: 'f'.repeat(40), backupDir: '/b' },
      () => {
        seen = upgradeCompletedTo(state(), 'f'.repeat(40));
      }
    );
    expect(seen).toBe(false);
  });
});
