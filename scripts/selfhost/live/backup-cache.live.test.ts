/** Actual Docker Compose mount selection, including an operator overlay replacing the cache. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  assertRollbackCacheReady,
  type BoxContext,
  composeArgs,
  composeRunEnv,
  OBJECTSTORE_IMAGE,
} from '../backup-lib';
import { requireRunningCelld } from '../backup-runtime';
import { recordInstall } from '../install-record';
import { LIVE_TMP, skipWithoutDocker } from './harness';

let root = '';
let context: BoxContext | undefined;
function docker(args: string[]): void {
  const result = context!.run('docker', composeArgs(context!, args), composeRunEnv(context!));
  if (result.status !== 0) throw new Error('Disposable cache fixture Docker command failed');
}

describe.skipIf(skipWithoutDocker)(
  'rollback cache proof against real selected Compose mounts',
  () => {
    beforeAll(() => {
      for (const name of Object.keys(process.env)) {
        if (name === 'CI' || name === 'GITHUB_ACTIONS' || name.startsWith('RUNNER_'))
          vi.stubEnv(name, undefined);
      }
      mkdirSync(LIVE_TMP, { recursive: true });
      root = mkdtempSync(join(LIVE_TMP, 'cache-proof-'));
      const stateDir = join(root, 'state');
      mkdirSync(stateDir, { mode: 0o700 });
      writeFileSync(
        join(stateDir, 'platform-keys.json'),
        JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32) }),
        { mode: 0o600 }
      );
      const envFile = join(root, 'box.env');
      writeFileSync(envFile, 'CELLD_BUCKET=gs://unused/celld\n', { mode: 0o600 });
      const compose = join(root, 'compose.yml');
      writeFileSync(
        compose,
        `services:\n  celld:\n    image: ${OBJECTSTORE_IMAGE}\n    entrypoint: /bin/sh\n    command: ["-c", "sleep 300"]\n    volumes:\n      - celld-data:/var/lib/celld\nvolumes:\n  celld-data: {}\n`
      );
      context = {
        box: { CELLD_BUCKET: 'gs://unused/celld' },
        stateDir,
        envFile,
        composeFiles: [compose],
        now: Date.now,
        log: () => undefined,
        run(command, args, env) {
          if (command !== 'docker')
            throw new Error('Cloud commands forbidden in disposable cache fixture');
          const result = spawnSync(command, args, { env: env ?? process.env, encoding: 'utf8' });
          return {
            status: result.status ?? 1,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          };
        },
      };
      recordInstall(stateDir, envFile, context.box, 'a'.repeat(32));
      docker(['up', '-d', 'celld']);
    });
    afterAll(() => {
      try {
        if (context) docker(['down', '--volumes', '--remove-orphans']);
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    });
    it('accepts canonical cache and rejects an overlay replacing the actual container mount', () => {
      requireRunningCelld(context!);
      const proof = assertRollbackCacheReady(context!);
      expect(proof.name).toMatch(/^sam-selfhost-[a-f0-9]{12}_celld-data$/);
      expect(proof.container).toMatch(/^[a-f0-9]{64}$/);
      docker(['stop', 'celld']);
      expect(() => requireRunningCelld(context!)).toThrow('exactly one running celld container');
      expect(assertRollbackCacheReady(context!).container).toBe(proof.container);
      const overlay = join(root, 'override.yml');
      writeFileSync(
        overlay,
        'services:\n  celld:\n    volumes:\n      - other-cache:/var/lib/celld\nvolumes:\n  other-cache: {}\n'
      );
      context!.composeFiles.push(overlay);
      docker(['up', '-d', 'celld']);
      expect(() => assertRollbackCacheReady(context!)).toThrow(
        'Selected celld cache mount is not the canonical owned volume'
      );
    });
  }
);
