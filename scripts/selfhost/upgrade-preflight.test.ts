import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { composeProjectFor, expectedComposeProjectFor, recordInstall } from './install-record.js';
import { type BoxContext, loadBox, type Runner, runUpgrade } from './upgrade-lib.js';

let root: string;
let context: BoxContext;
let runner: Mock<Runner>;

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
      vi.stubEnv(name, undefined);
  }
  mkdirSync(resolve('.tmp'), { recursive: true });
  root = mkdtempSync(join(resolve('.tmp'), 'upgrade-ownership-'));
  const stateDir = join(root, 'state');
  const envFile = join(root, 'box.env');
  mkdirSync(stateDir);
  runner = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
  context = {
    box: { SAM_DOMAIN: 'install.example', CELLD_BUCKET: 'gs://owned/fleet' },
    stateDir,
    envFile,
    composeFiles: ['compose.yml'],
    run: runner,
    log: vi.fn(),
  };
  recordInstall(stateDir, envFile, context.box, 'installation-identity');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const upgrade = () => runUpgrade(context, { to: 'release', checkHealth: async () => true });

describe('upgrade rollback ownership preflight at the production trigger', () => {
  it.each(['sam-selfhost', 'another-install'])(
    'refuses legacy/shared compose project %s before backup, checkout or any runner command',
    async (project) => {
      context.box = { ...context.box, COMPOSE_PROJECT_NAME: project };
      await expect(upgrade()).rejects.toThrow(
        /migrate to an installation-specific compose project/
      );
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'removed', 'reused', 'foreign', 'duplicate', 'malformed'])(
    'refuses %s compose ownership receipt before runner commands',
    async (kind) => {
      const file = join(context.stateDir, 'created-resources.json');
      const receipt = {
        cloud: 'box',
        kind: 'compose-project',
        name: composeProjectFor(context.box, context.stateDir),
        action: 'created',
        createdBy: 'deploy',
        attributes: {},
      };
      let resources: Record<string, unknown>[] = [receipt];
      if (kind === 'missing') resources = [];
      if (kind === 'removed') resources[0] = { ...receipt, removedAt: new Date().toISOString() };
      if (kind === 'reused') resources[0] = { ...receipt, action: 'reused' };
      if (kind === 'foreign') resources[0] = { ...receipt, name: 'foreign-project' };
      if (kind === 'duplicate') resources.push({ ...receipt });
      writeFileSync(
        file,
        kind === 'malformed'
          ? '{"secret":"do-not-print"'
          : JSON.stringify({ format: 'sam-created-resources/1', resources })
      );
      await expect(upgrade()).rejects.toThrow(/Upgrade refused:.*receipt/);
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it('allows exact current installation receipt to reach git and a genuine no-op upgrade', async () => {
    context.box = {
      ...context.box,
      COMPOSE_PROJECT_NAME: expectedComposeProjectFor(context.box, context.stateDir),
    };
    const sha = 'a'.repeat(40);
    runner.mockImplementation((_command, args: string[]) => ({
      status: 0,
      stdout: args[0] === 'rev-parse' ? sha : '',
      stderr: '',
    }));
    const result = await upgrade();
    expect(result.from).toBe(sha);
    expect(result.to).toBe(sha);
    expect(runner).toHaveBeenCalledWith('git', ['fetch', '--tags', 'origin']);
    expect(result.backupDir).toBeNull();
  });

  it.each(['GITHUB_ACTIONS', 'CI', 'RUNNER_TEMP', 'RUNNER_NAME'])(
    'runUpgrade rejects %s before receipt reads or runner commands',
    async (signal) => {
      vi.stubEnv(signal, 'true');
      rmSync(context.stateDir, { recursive: true, force: true });
      await expect(upgrade()).rejects.toThrow(/forbidden in CI/);
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each(['GITHUB_ACTIONS', 'CI', 'RUNNER_TEMP', 'RUNNER_NAME'])(
    'public loadBox rejects %s before reading env',
    (signal) => {
      vi.stubEnv(signal, 'true');
      expect(() => loadBox(join(root, 'does-not-exist'))).toThrow(/forbidden in CI/);
    }
  );
});
