/** Actual canonical Compose bootstrap, encrypted restore, and refusal of a real celld-labelled runtime. */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { encryptBackupTree } from '../backup-encryption';
import { type BoxContext, composeArgs, composeRunEnv, pullBucket, runRestore } from '../backup-lib';
import { CLOSED_HOST, runDeploy } from '../deploy-harness';
import { freePort, LIVE_TMP, skipWithoutDocker } from './harness';

let root = '',
  project = '',
  runtime = '';
const run: BoxContext['run'] = (command, args, env) => {
  const r = spawnSync(command, args, { env: env ?? process.env, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
afterEach(() => {
  if (runtime) run('docker', ['rm', '-f', '-v', runtime]);
  if (project) {
    for (const role of ['objectstore', 'objectstore-init'])
      run('docker', ['rm', '-f', '-v', `${project}-${role}-1`]);
    run('docker', ['volume', 'rm', `${project}_objectstore-data`]);
  }
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it.skipIf(skipWithoutDocker)(
  'restores through actual canonical store-only Compose and keeps its volume across init; refuses real celld',
  async () => {
    for (const n of Object.keys(process.env))
      if (n === 'CI' || n === 'GITHUB_ACTIONS' || n.startsWith('RUNNER_')) vi.stubEnv(n, undefined);
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'restore-canonical-'));
    const port = await freePort(),
      consolePort = await freePort(),
      plain = join(root, 'plain'),
      snapshot = join(root, 'encrypted');
    mkdirSync(join(plain, 'state'), { recursive: true });
    mkdirSync(join(plain, 'bucket/data'), { recursive: true });
    writeFileSync(join(root, 'key'), randomBytes(32), { mode: 0o600 });
    writeFileSync(
      join(plain, 'state/platform-keys.json'),
      JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32), ENCRYPTION_KEY: 'preserved-fixture' }),
      { mode: 0o600 }
    );
    writeFileSync(join(plain, 'bucket/data/value'), 'actual restored bytes');
    writeFileSync(
      join(plain, 'backup-manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        bucket: 's3://source/celld',
        samCommit: null,
        precopyMs: 0,
        downtimeMs: 0,
        deltaCopyMs: 0,
        objectCount: 1,
      })
    );
    encryptBackupTree(plain, snapshot, join(root, 'key'));
    const box: Record<string, string> = {
      SAM_DOMAIN: 'restore.example.com',
      SAM_TLS_MODE: 'internal',
      COMPOSE_PROFILES: 'local-store',
      CELLD_BUCKET: 's3://restore/celld',
      R2_S3_REGION: 'us-east-1',
      S3_ENDPOINT: `http://127.0.0.1:${port}`,
      AWS_ACCESS_KEY_ID: 'restore-local-fixture',
      AWS_SECRET_ACCESS_KEY: 'restore-local-secret-at-least24chars',
      OBJECTSTORE_PORT: String(port),
      OBJECTSTORE_CONSOLE_PORT: String(consolePort),
      // Hermetic key choice: the runner's own metadata service (a CI host can look like AWS) must
      // not decide how --init seals the restored box.
      SAM_GCE_METADATA_HOST: CLOSED_HOST,
      SAM_AWS_IMDS_HOST: CLOSED_HOST,
      SAM_AZURE_IMDS_HOST: CLOSED_HOST,
    };
    const context: BoxContext = {
      box,
      stateDir: join(root, 'state'),
      envFile: join(root, 'target.env'),
      encryptionKeyFile: join(root, 'key'),
      composeFiles: [resolve(import.meta.dirname, '../../../deploy/selfhost/docker-compose.yml')],
      run,
      now: Date.now,
      log: () => {},
      user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    };
    writeFileSync(
      context.envFile,
      Object.entries(box)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      { mode: 0o600 }
    );
    project = runRestore(context, snapshot, 'project');
    box.COMPOSE_PROJECT_NAME = project;
    writeFileSync(
      context.envFile,
      Object.entries(box)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    );
    const started = run(
      'docker',
      composeArgs(context, ['up', '-d', 'objectstore', 'objectstore-init']),
      composeRunEnv(context)
    );
    expect(started.status, started.stderr).toBe(0);
    for (let i = 0; i < 60; i++) {
      const done = run('docker', [
        'inspect',
        '--format',
        '{{.State.Status}}',
        `${project}-objectstore-init-1`,
      ]);
      if (done.stdout.trim() === 'exited') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    runRestore(context, snapshot);
    const checked = join(root, 'verified');
    pullBucket(context, checked);
    expect(readFileSync(join(checked, 'data/value'), 'utf8')).toBe('actual restored bytes');
    const volume = run('docker', [
      'volume',
      'inspect',
      '--format',
      '{{.Name}}',
      `${project}_objectstore-data`,
    ]);
    expect(volume.status).toBe(0);
    expect(volume.stdout.trim()).toBe(`${project}_objectstore-data`);
    const initialized = await runDeploy(context.envFile, [
      '--init',
      '--state-dir',
      context.stateDir,
    ]);
    expect(initialized.status, initialized.out).toBe(0);
    const repeated = run(
      'docker',
      composeArgs(context, ['up', '-d', 'objectstore', 'objectstore-init']),
      composeRunEnv(context)
    );
    expect(repeated.status, repeated.stderr).toBe(0);
    const afterInit = join(root, 'verified-after-init');
    pullBucket(context, afterInit);
    expect(readFileSync(join(afterInit, 'data/value'), 'utf8')).toBe('actual restored bytes');
    const blocked = run('docker', [
      'run',
      '-d',
      '--label',
      `com.docker.compose.project=${project}`,
      '--label',
      'com.docker.compose.service=celld',
      '--entrypoint',
      'sleep',
      'pgsty/minio@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372',
      '300',
    ]);
    expect(blocked.status).toBe(0);
    runtime = blocked.stdout.trim();
    expect(() => runRestore(context, snapshot)).toThrow(/already has containers/);
    expect(readFileSync(join(checked, 'data/value'), 'utf8')).toBe('actual restored bytes');
  },
  120_000
);
