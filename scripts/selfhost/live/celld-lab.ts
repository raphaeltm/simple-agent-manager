/**
 * A celld node on loopback for the live suite: the box's object store (the pinned MinIO image),
 * the pinned celld binary serving from it, and `celld deploy` of a probe project. Shared by every
 * live test that runs a Worker on the real runtime, so each test states only what it probes.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sealSecrets } from '../../../deploy/selfhost/key-agent/bundle.ts';
import {
  createFileProvider,
  generateFileKek,
} from '../../../deploy/selfhost/key-agent/provider-file.ts';
import { OBJECTSTORE_IMAGE } from '../backup-lib';
import { resolveEsbuild } from '../celld-binary.js';
import { freePort, REPO_ROOT, type Running, start, waitFor } from './harness';

/**
 * The docker CLI from a fixed system directory, never resolved through a caller-controlled PATH
 * (as harness.ts does for tar and openssl). Empty when docker is not installed.
 */
export const DOCKER =
  ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'].find((path) => existsSync(path)) ??
  '';
export const hasDocker =
  DOCKER !== '' && spawnSync(DOCKER, ['version'], { stdio: 'ignore' }).status === 0;

export interface ObjectStore {
  port: number;
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** The S3 credentials celld and its deploy command read. */
  env: () => Record<string, string>;
  /** `mc` from the same image, with `src` aliased to this store. `extra` goes before the image. */
  mc: (args: string[], extra?: string[]) => SpawnSyncReturns<string>;
  stop: () => void;
}

/** Start the pinned object store on a free loopback port and create the `fleet` bucket. */
export async function startObjectStore(key: string, secret: string): Promise<ObjectStore> {
  const port = await freePort();
  const run = spawnSync(
    DOCKER,
    [
      'run',
      '-d',
      '--rm',
      '--network',
      'host',
      '-e',
      `MINIO_ROOT_USER=${key}`,
      '-e',
      `MINIO_ROOT_PASSWORD=${secret}`,
      '--entrypoint',
      'minio',
      OBJECTSTORE_IMAGE,
      'server',
      '/data',
      '--address',
      `127.0.0.1:${port}`,
      '--console-address',
      `127.0.0.1:${await freePort()}`,
    ],
    { encoding: 'utf8' }
  );
  if (run.status !== 0) throw new Error(`object store did not start: ${run.stderr}`);
  const container = run.stdout.trim();
  const url = `http://127.0.0.1:${port}`;
  const store: ObjectStore = {
    port,
    url,
    env: () => ({ AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: secret, AWS_REGION: 'us-east-1' }),
    mc: (args, extra = []) =>
      spawnSync(
        DOCKER,
        [
          'run',
          '--rm',
          '--network',
          'host',
          ...extra,
          '-e',
          `MC_HOST_src=http://${key}:${secret}@127.0.0.1:${port}`,
          '-e',
          'MC_CONFIG_DIR=/tmp/mc',
          '--entrypoint',
          'mc',
          OBJECTSTORE_IMAGE,
          ...args,
        ],
        { encoding: 'utf8' }
      ),
    stop: () => {
      spawnSync(DOCKER, ['rm', '-f', container]);
    },
  };
  try {
    await waitFor(
      'object store',
      async () => (await fetch(`${url}/minio/health/live`).catch(() => null))?.ok
    );
    const made = store.mc(['mb', 'src/fleet']);
    if (made.status !== 0) throw new Error(`bucket not created: ${made.stderr}`);
  } catch (error) {
    store.stop();
    throw error;
  }
  return store;
}

export interface CelldNode {
  /** Ports celld serves Workers and its internal API on. */
  port: number;
  internalPort: number;
  /** `--bucket <bucket> --endpoint <store>` for celld and `celld deploy`. */
  bucketArgs: () => string[];
  start: () => Running;
  /** `celld deploy <project>`; the caller asserts on the result. */
  deploy: (project: string) => SpawnSyncReturns<string>;
  /** Start celld, deploy `project`, and wait until `/` answers 200. */
  serve: (project: string) => Promise<Running>;
}

/** A celld node over `store`, serving `bucket` (an s3:// URL inside the `fleet` bucket). */
export async function celldNode(
  binary: string,
  store: ObjectStore,
  bucket = 's3://fleet'
): Promise<CelldNode> {
  const port = await freePort();
  const internalPort = await freePort();
  const bucketArgs = () => ['--bucket', bucket, '--endpoint', store.url];
  const node: CelldNode = {
    port,
    internalPort,
    bucketArgs,
    start: () =>
      start(
        binary,
        [
          ...bucketArgs(),
          '--listen',
          `127.0.0.1:${port}`,
          '--internal-listen',
          `127.0.0.1:${internalPort}`,
        ],
        store.env()
      ),
    deploy: (project) =>
      spawnSync(binary, ['deploy', project, ...bucketArgs()], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...store.env(),
          CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')),
        },
      }),
    serve: async (project) => {
      const running = node.start();
      const deployed = node.deploy(project);
      if (deployed.status !== 0) {
        await running.stop();
        throw new Error(`celld deploy failed: ${deployed.stderr}${deployed.stdout}`);
      }
      await waitFor(
        'celld to serve the Worker',
        async () => (await fetch(`http://127.0.0.1:${port}/`).catch(() => null))?.status === 200,
        120_000,
        () => running.output()
      );
      return running;
    },
  };
  return node;
}

/**
 * Write a celld project: the Worker source plus its `wrangler.json`. `bindings` adds top-level
 * wrangler keys (`d1_databases`, `r2_buckets`, ...); `probeObject` binds the `ProbeDO` class.
 */
export function writeProject(
  dir: string,
  config: {
    name: string;
    worker: string;
    vars: Record<string, string>;
    probeObject?: boolean;
    main?: string;
    bindings?: Record<string, unknown>;
  }
): string {
  const main = config.main ?? 'worker.js';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, main), config.worker);
  writeFileSync(
    join(dir, 'wrangler.json'),
    JSON.stringify({
      name: config.name,
      main,
      compatibility_date: '2026-01-01',
      ...(config.probeObject
        ? {
            durable_objects: { bindings: [{ name: 'PROBE_DO', class_name: 'ProbeDO' }] },
            migrations: [{ tag: 'v1', new_sqlite_classes: ['ProbeDO'] }],
          }
        : {}),
      ...config.bindings,
      vars: config.vars,
    })
  );
  return dir;
}

export interface SealedBundle {
  bundleId: string;
  /** The agent's Ed25519 public key, base64, as `SAM_KEY_AGENT_VERIFY_KEY`. */
  verifyKey: string;
  /** The file provider's key file, as `SAM_KEY_FILE`. */
  kekFile: string;
  bundleDir: string;
}

/**
 * Seal `secrets` the way the deploy does (scripts/selfhost/key-service.ts), file provider, with a
 * fresh agent signing key. Writes `<stateDir>/kek` and `<stateDir>/bundles/<id>.json`.
 */
export async function sealBundle(
  stateDir: string,
  secrets: Record<string, string>,
  installationId: string
): Promise<SealedBundle> {
  const bundleDir = join(stateDir, 'bundles');
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const kekFile = join(stateDir, 'kek');
  writeFileSync(kekFile, generateFileKek(), { mode: 0o600 });
  const agentKey = generateKeyPairSync('ed25519');
  const verifyKey = Buffer.from(
    String(agentKey.publicKey.export({ format: 'jwk' }).x),
    'base64url'
  ).toString('base64');
  const signing = agentKey.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const bundle = await sealSecrets(
    { ...secrets, SAM_KEY_AGENT_SIGNING_KEY: signing },
    createFileProvider({ SAM_KEY_FILE: kekFile }),
    { installationId }
  );
  writeFileSync(join(bundleDir, `${bundle.bundleId}.json`), JSON.stringify(bundle), {
    mode: 0o600,
  });
  return { bundleId: bundle.bundleId, verifyKey, kekFile, bundleDir };
}

/** The key agent (deploy/selfhost/key-agent/server.ts), file provider, serving `bundle`. */
export function startKeyAgent(bundle: SealedBundle, port: number, allowedUid: number): Running {
  return start('node', [join(REPO_ROOT, 'deploy/selfhost/key-agent/server.ts')], {
    SAM_KEY_PROVIDER: 'file',
    SAM_KEY_FILE: bundle.kekFile,
    SAM_KEY_AGENT_PORT: String(port),
    SAM_KEY_AGENT_BUNDLE_DIR: bundle.bundleDir,
    SAM_KEY_AGENT_ALLOWED_UIDS: String(allowedUid),
  });
}
