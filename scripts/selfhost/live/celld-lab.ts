/**
 * A celld node on loopback for the live suite: the box's object store (the pinned MinIO image),
 * the pinned celld binary serving from it, and `celld deploy` of a probe project, so a test that
 * runs a Worker on the real runtime states only what it probes (shared-flight-cancel today).
 * writeProject also serves tests that run `celld dev` on a bare project (celld-redirect).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { resolveEsbuild } from '../celld-binary.js';
import { childEnv, DOCKER, freePort, REPO_ROOT, type Running, start, waitFor } from './harness';

/** The object store image docker-compose.yml pins (digest); `mc` ships in it. */
export const OBJECTSTORE_IMAGE = (
  parse(readFileSync(join(REPO_ROOT, 'deploy/selfhost/docker-compose.yml'), 'utf8')) as {
    services: { objectstore: { image: string } };
  }
).services.objectstore.image;

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
        env: childEnv({
          ...store.env(),
          CELLD_ESBUILD: resolveEsbuild(join(REPO_ROOT, 'apps/api')),
        }),
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
