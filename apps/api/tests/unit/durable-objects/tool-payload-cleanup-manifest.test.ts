/**
 * Structural validation of operator-supplied cleanup manifests.
 *
 * The SHA-256/byte gate in `readVerifiedJson` only proves the object is the one the
 * operator approved. It says nothing about the manifest being internally coherent, so a
 * writer bug that emits a correctly hashed but structurally wrong manifest (batch bound
 * to a different plan, non-monotonic row ids, totals that disagree with the proofs)
 * would otherwise reach the cleanup engine and let it skip or double-process rows.
 * These tests drive the real readers against a real in-memory R2 double with real
 * digests, so every assertion exercises the production parse path.
 */
import { describe, expect, it } from 'vitest';

import {
  readToolPayloadCleanupManifestBatch,
  readToolPayloadCleanupManifestRoot,
  type ToolPayloadCleanupManifestBatchProof,
  type ToolPayloadCleanupManifestRoot,
} from '../../../src/durable-objects/project-data/tool-payload-cleanup-manifest';

const PROJECT_ID = 'project-manifest-structural';
const PLAN_ID = 'plan-manifest-structural';
const CUTOFF = 1_700_000_000_000;

type StoredObject = { key: string; bytes: number; sha256: string };

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: string): Promise<null> {
    this.objects.set(key, new TextEncoder().encode(value));
    return null;
  }

  get(key: string) {
    const stored = this.objects.get(key);
    if (!stored) return Promise.resolve(null);
    return Promise.resolve({
      arrayBuffer: () =>
        Promise.resolve(
          stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength)
        ),
    });
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function store(r2: MemoryR2, key: string, value: unknown): Promise<StoredObject> {
  const body = JSON.stringify(value);
  await r2.put(key, body);
  const bytes = new TextEncoder().encode(body);
  return { key, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

function makeTarget(rowId: number, overrides: Record<string, unknown> = {}) {
  return {
    rowId,
    sessionId: `session-${rowId}`,
    messageId: `message-${rowId}`,
    messageCreatedAt: CUTOFF - 1_000,
    messageSequence: rowId,
    toolMetadataBytes: 2_048,
    toolMetadataSha256: 'a'.repeat(64),
    projectedReclaimableBytes: 1_024,
    ...overrides,
  };
}

function readRoot(r2: MemoryR2, stored: StoredObject) {
  return readToolPayloadCleanupManifestRoot({
    r2: r2 as unknown as R2Bucket,
    key: stored.key,
    sha256: stored.sha256,
    timeoutMs: 5_000,
    deadlineMs: Date.now() + 10_000,
  });
}

function readBatch(
  r2: MemoryR2,
  proof: ToolPayloadCleanupManifestBatchProof,
  root: ToolPayloadCleanupManifestRoot
) {
  return readToolPayloadCleanupManifestBatch({
    r2: r2 as unknown as R2Bucket,
    proof,
    root,
    timeoutMs: 5_000,
    deadlineMs: Date.now() + 10_000,
  });
}

function baseProof(
  overrides: Partial<ToolPayloadCleanupManifestBatchProof> = {}
): ToolPayloadCleanupManifestBatchProof {
  return {
    ordinal: 0,
    key: 'batch-0',
    bytes: 1,
    sha256: 'b'.repeat(64),
    targetCount: 2,
    projectedReclaimableBytes: 2_048,
    firstRowId: 1,
    lastRowId: 2,
    ...overrides,
  };
}

function baseRoot(
  overrides: Partial<ToolPayloadCleanupManifestRoot> = {}
): ToolPayloadCleanupManifestRoot {
  return {
    version: 1,
    planId: PLAN_ID,
    projectId: PROJECT_ID,
    cutoffCreatedAt: CUTOFF,
    createdAt: CUTOFF,
    eligibleRows: 2,
    eligibleBytes: 2_048,
    batches: [baseProof()],
    ...overrides,
  };
}

describe('tool payload cleanup manifest — root structure', () => {
  it('accepts a coherent root manifest', async () => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', baseRoot());
    await expect(readRoot(r2, stored)).resolves.toMatchObject({
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      eligibleRows: 2,
    });
  });

  it.each([
    ['a JSON array instead of an object', ['not', 'a', 'manifest']],
    ['a JSON string instead of an object', 'not a manifest'],
    ['an unknown manifest version', { ...baseRoot(), version: 2 }],
    ['a missing plan id', { ...baseRoot(), planId: '' }],
    ['a missing project id', { ...baseRoot(), projectId: '' }],
    ['a non-array batches field', { ...baseRoot(), batches: {} }],
  ])('rejects %s', async (_label, value) => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', value);
    await expect(readRoot(r2, stored)).rejects.toThrow(/root manifest is malformed/);
  });

  it.each([
    ['a negative created-at', { ...baseRoot(), createdAt: -1 }],
    ['a non-integer eligible row count', { ...baseRoot(), eligibleRows: 1.5 }],
  ])('rejects %s', async (_label, value) => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', value);
    await expect(readRoot(r2, stored)).rejects.toThrow(/is invalid/);
  });

  it.each([
    ['an ordinal that does not match its index', [baseProof({ ordinal: 3 })]],
    ['a non-hex batch digest', [baseProof({ sha256: 'not-a-digest' })]],
    ['a last row id below its first', [baseProof({ firstRowId: 9, lastRowId: 2 })]],
    [
      'batches whose row ranges overlap',
      [baseProof(), baseProof({ ordinal: 1, key: 'batch-1', firstRowId: 2, lastRowId: 4 })],
    ],
  ])('rejects %s', async (_label, batches) => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', baseRoot({ batches, eligibleRows: 2 * batches.length }));
    await expect(readRoot(r2, stored)).rejects.toThrow(/root batch proof is malformed/);
  });

  it('rejects totals that disagree with the batch proofs', async () => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', baseRoot({ eligibleRows: 99 }));
    await expect(readRoot(r2, stored)).rejects.toThrow(/totals do not match batch proofs/);
  });

  it('rejects a configured digest that is not 64 hex characters', async () => {
    const r2 = new MemoryR2();
    const stored = await store(r2, 'root', baseRoot());
    await expect(
      readToolPayloadCleanupManifestRoot({
        r2: r2 as unknown as R2Bucket,
        key: stored.key,
        sha256: 'short',
        timeoutMs: 5_000,
        deadlineMs: Date.now() + 10_000,
      })
    ).rejects.toThrow(/SHA-256 is malformed/);
  });

  it('rejects a missing object', async () => {
    const r2 = new MemoryR2();
    await expect(
      readToolPayloadCleanupManifestRoot({
        r2: r2 as unknown as R2Bucket,
        key: 'absent',
        sha256: 'c'.repeat(64),
        timeoutMs: 5_000,
        deadlineMs: Date.now() + 10_000,
      })
    ).rejects.toThrow(/is missing/);
  });
});

describe('tool payload cleanup manifest — batch structure', () => {
  const targets = [makeTarget(1), makeTarget(2)];

  async function storedBatch(r2: MemoryR2, value: unknown) {
    return store(r2, 'batch-0', value);
  }

  it('accepts a coherent batch bound to its root and proof', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets,
    });
    await expect(
      readBatch(r2, baseProof({ bytes: stored.bytes, sha256: stored.sha256 }), baseRoot())
    ).resolves.toMatchObject({ ordinal: 0 });
  });

  it.each([
    ['a different project', { projectId: 'some-other-project' }],
    ['a different plan', { planId: 'some-other-plan' }],
    ['a different cutoff', { cutoffCreatedAt: CUTOFF - 1 }],
    ['an ordinal that disagrees with its proof', { ordinal: 7 }],
    ['a target count that disagrees with its proof', { targets: [makeTarget(1)] }],
  ])('rejects a batch bound to %s', async (_label, override) => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets,
      ...override,
    });
    await expect(
      readBatch(r2, baseProof({ bytes: stored.bytes, sha256: stored.sha256 }), baseRoot())
    ).rejects.toThrow(/batch manifest identity is invalid/);
  });

  it('rejects targets that are not strictly ordered by row id', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets: [makeTarget(2), makeTarget(1)],
    });
    await expect(
      readBatch(r2, baseProof({ bytes: stored.bytes, sha256: stored.sha256 }), baseRoot())
    ).rejects.toThrow(/targets are not strictly ordered/);
  });

  it('rejects a malformed target hash', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets: [makeTarget(1), makeTarget(2, { toolMetadataSha256: 'nope' })],
    });
    await expect(
      readBatch(r2, baseProof({ bytes: stored.bytes, sha256: stored.sha256 }), baseRoot())
    ).rejects.toThrow(/target identity or hash is malformed/);
  });

  it('rejects projected bytes that disagree with the proof', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets,
    });
    await expect(
      readBatch(
        r2,
        baseProof({
          bytes: stored.bytes,
          sha256: stored.sha256,
          projectedReclaimableBytes: 9_999,
        }),
        baseRoot()
      )
    ).rejects.toThrow(/projected bytes do not match proof/);
  });

  it('rejects row bounds that disagree with the proof', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets,
    });
    await expect(
      readBatch(
        r2,
        baseProof({ bytes: stored.bytes, sha256: stored.sha256, firstRowId: 5, lastRowId: 2 }),
        baseRoot()
      )
    ).rejects.toThrow(/row bounds do not match proof/);
  });

  it('rejects a byte length that disagrees with the proof', async () => {
    const r2 = new MemoryR2();
    const stored = await storedBatch(r2, {
      version: 1,
      planId: PLAN_ID,
      projectId: PROJECT_ID,
      cutoffCreatedAt: CUTOFF,
      ordinal: 0,
      targets,
    });
    await expect(
      readBatch(r2, baseProof({ bytes: stored.bytes + 1, sha256: stored.sha256 }), baseRoot())
    ).rejects.toThrow(/byte verification failed/);
  });
});
