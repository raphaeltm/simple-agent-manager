import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/logger', () => ({
  createModuleLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { Env } from '../../../src/env';
import {
  COMPOSE_IMAGE_ARTIFACT_PREFIX,
  runComposeImageArtifactCleanup,
  runScheduledComposeImageArtifactCleanup,
} from '../../../src/scheduled/compose-image-artifact-cleanup';

interface ReleaseRow {
  id: string;
  manifest: string;
}

interface ListedObject {
  key: string;
  size: number;
  uploaded: Date;
}

function makeDb(rows: ReleaseRow[]): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((pattern: string) => ({
        all: vi.fn(async () => {
          expect(sql).toContain('FROM deployment_releases');
          expect(pattern).toBe(`%${COMPOSE_IMAGE_ARTIFACT_PREFIX}%`);
          return { results: rows };
        }),
      })),
    })),
  } as unknown as D1Database;
}

function makeR2(objects: ListedObject[], options: { deleteErrorFor?: string; listError?: boolean } = {}) {
  const deleted: string[] = [];
  const r2 = {
    list: vi.fn(async (listOptions: { prefix?: string; cursor?: string; limit?: number }) => {
      expect(listOptions.prefix).toBe(COMPOSE_IMAGE_ARTIFACT_PREFIX);
      expect(listOptions.limit).toBe(1000);
      if (options.listError) {
        throw new Error('list failed');
      }
      return { objects, truncated: false };
    }),
    delete: vi.fn(async (key: string) => {
      if (key === options.deleteErrorFor) {
        throw new Error('delete failed');
      }
      deleted.push(key);
    }),
    deleted,
  };
  return r2;
}

function makeKv(lastRun: string | null = null) {
  return {
    get: vi.fn(async () => lastRun),
    put: vi.fn(async () => undefined),
  };
}

function makeEnv(options: {
  rows?: ReleaseRow[];
  objects?: ListedObject[];
  kvLastRun?: string | null;
  overrides?: Partial<Env>;
  deleteErrorFor?: string;
  listError?: boolean;
} = {}): Env & { R2: ReturnType<typeof makeR2>; KV: ReturnType<typeof makeKv> } {
  const r2 = makeR2(options.objects ?? [], {
    deleteErrorFor: options.deleteErrorFor,
    listError: options.listError,
  });
  const kv = makeKv(options.kvLastRun ?? null);
  return {
    DATABASE: makeDb(options.rows ?? []),
    R2: r2,
    KV: kv,
    ...options.overrides,
  } as unknown as Env & { R2: ReturnType<typeof makeR2>; KV: ReturnType<typeof makeKv> };
}

function artifactKey(name: string): string {
  return `${COMPOSE_IMAGE_ARTIFACT_PREFIX}project/env/workspace/upload/${name}.docker-save.tar`;
}

function oldObject(name: string, size = 100): ListedObject {
  return {
    key: artifactKey(name),
    size,
    uploaded: new Date('2026-06-20T00:00:00Z'),
  };
}

function youngObject(name: string): ListedObject {
  return {
    key: artifactKey(name),
    size: 100,
    uploaded: new Date('2026-06-27T11:00:00Z'),
  };
}

describe('compose image artifact cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-27T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes only old unreferenced compose image artifacts', async () => {
    const referencedKey = artifactKey('api');
    const env = makeEnv({
      rows: [
        {
          id: 'release-1',
          manifest: JSON.stringify({
            services: [{ serviceName: 'api', r2Key: referencedKey }],
          }),
        },
      ],
      objects: [oldObject('api', 200), oldObject('orphan', 300), youngObject('new-upload')],
    });

    const result = await runComposeImageArtifactCleanup(env);

    expect(env.R2.deleted).toEqual([artifactKey('orphan')]);
    expect(result).toMatchObject({
      scannedObjects: 3,
      referencedKeys: 1,
      retainedReferenced: 1,
      retainedYoung: 1,
      deleteCandidates: 1,
      deletedObjects: 1,
      deletedBytes: 300,
      errors: 0,
    });
  });

  it('fails closed and deletes nothing when a relevant release manifest is invalid', async () => {
    const env = makeEnv({
      rows: [{ id: 'release-bad', manifest: '{"services": [' }],
      objects: [oldObject('orphan')],
    });

    const result = await runComposeImageArtifactCleanup(env);

    expect(env.R2.list).not.toHaveBeenCalled();
    expect(env.R2.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'reference-collection-failed',
      deletedObjects: 0,
      errors: 1,
    });
  });

  it('bounds deletion by configured batch size', async () => {
    const env = makeEnv({
      objects: [oldObject('one'), oldObject('two'), oldObject('three')],
      overrides: { COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE: '2' },
    });

    const result = await runComposeImageArtifactCleanup(env);

    expect(env.R2.deleted).toEqual([artifactKey('one'), artifactKey('two')]);
    expect(result).toMatchObject({
      deleteCandidates: 2,
      deletedObjects: 2,
    });
  });

  it('honors the cleanup kill switch before D1 or R2 access', async () => {
    const env = makeEnv({
      objects: [oldObject('orphan')],
      overrides: { COMPOSE_IMAGE_ARTIFACT_CLEANUP_ENABLED: 'false' },
    });

    const result = await runComposeImageArtifactCleanup(env);

    expect(env.R2.list).not.toHaveBeenCalled();
    expect(env.R2.delete).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      enabled: false,
      skipped: true,
      skipReason: 'disabled',
      deletedObjects: 0,
    });
  });

  it('records delete errors without exposing object keys in thrown output', async () => {
    const failingKey = artifactKey('failing');
    const env = makeEnv({
      objects: [oldObject('ok'), { ...oldObject('failing'), key: failingKey }],
      deleteErrorFor: failingKey,
    });

    const result = await runComposeImageArtifactCleanup(env);

    expect(env.R2.deleted).toEqual([artifactKey('ok')]);
    expect(result).toMatchObject({
      deleteCandidates: 2,
      deletedObjects: 1,
      errors: 1,
    });
  });

  it('fails closed without throwing when R2 listing fails', async () => {
    const env = makeEnv({
      objects: [oldObject('orphan')],
      listError: true,
    });

    const result = await runScheduledComposeImageArtifactCleanup(env);

    expect(env.R2.delete).not.toHaveBeenCalled();
    expect(env.KV.put).toHaveBeenCalledWith(
      'cleanup:compose-image-artifacts:last-run',
      '2026-06-27T12:00:00.000Z',
      { expirationTtl: 172800 }
    );
    expect(result).toMatchObject({
      scannedObjects: 0,
      deletedObjects: 0,
      errors: 1,
    });
  });

  it('skips scheduled cleanup until the configured interval elapses', async () => {
    const env = makeEnv({
      kvLastRun: '2026-06-27T00:00:00.000Z',
      objects: [oldObject('orphan')],
      overrides: { COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS: '24' },
    });

    const result = await runScheduledComposeImageArtifactCleanup(env);

    expect(env.KV.get).toHaveBeenCalled();
    expect(env.R2.list).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skipped: true,
      skipReason: 'interval-not-elapsed',
      deletedObjects: 0,
    });
  });

  it('runs scheduled cleanup after the interval and records the last run', async () => {
    const env = makeEnv({
      kvLastRun: '2026-06-26T00:00:00.000Z',
      objects: [oldObject('orphan')],
      overrides: { COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS: '24' },
    });

    const result = await runScheduledComposeImageArtifactCleanup(env);

    expect(env.R2.deleted).toEqual([artifactKey('orphan')]);
    expect(env.KV.put).toHaveBeenCalledWith(
      'cleanup:compose-image-artifacts:last-run',
      '2026-06-27T12:00:00.000Z',
      { expirationTtl: 172800 }
    );
    expect(result.deletedObjects).toBe(1);
  });
});
