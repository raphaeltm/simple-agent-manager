import type { ProjectDataStorageReliefToolPayloadTarget } from './storage-relief-measurement';
import type { ToolPayloadArchiveOperationBudget } from './tool-payload-archive-r2';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const TOOL_PAYLOAD_CLEANUP_MANIFEST_VERSION = 1 as const;
export const DEFAULT_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES = 2_000_000;
export const DEFAULT_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES = 1_000_000;

export type ToolPayloadCleanupManifestBatch = {
  version: typeof TOOL_PAYLOAD_CLEANUP_MANIFEST_VERSION;
  planId: string;
  projectId: string;
  cutoffCreatedAt: number;
  ordinal: number;
  targets: ProjectDataStorageReliefToolPayloadTarget[];
};

export type ToolPayloadCleanupManifestBatchProof = {
  ordinal: number;
  key: string;
  bytes: number;
  sha256: string;
  targetCount: number;
  projectedReclaimableBytes: number;
  firstRowId: number;
  lastRowId: number;
};

export type ToolPayloadCleanupManifestRoot = {
  version: typeof TOOL_PAYLOAD_CLEANUP_MANIFEST_VERSION;
  planId: string;
  projectId: string;
  cutoffCreatedAt: number;
  createdAt: number;
  eligibleRows: number;
  eligibleBytes: number;
  batches: ToolPayloadCleanupManifestBatchProof[];
};

export type VerifiedManifestObject<T> = {
  value: T;
  key: string;
  bytes: number;
  sha256: string;
};

function normalizePrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '');
  return normalized || 'project-data/tool-payloads';
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function remainingTimeout(timeoutMs: number, deadlineMs: number, nowMs: () => number): number {
  const remaining = deadlineMs - nowMs();
  if (remaining <= 0) throw new Error('tool payload cleanup manifest deadline exceeded');
  return Math.min(timeoutMs, remaining);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  operation.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function reserveOperations(
  budget: ToolPayloadArchiveOperationBudget | undefined,
  count: number
): void {
  if (!budget) return;
  if (budget.used + count > budget.max) {
    throw new Error(
      `R2 archive operation budget exceeded: ${budget.used + count} required, ${budget.max} allowed`
    );
  }
  budget.used += count;
}

async function writeVerifiedJson<T>(input: {
  r2: R2Bucket;
  key: string;
  value: T;
  timeoutMs: number;
  deadlineMs: number;
  maxBytes: number;
}): Promise<VerifiedManifestObject<T>> {
  const body = textEncoder.encode(JSON.stringify(input.value));
  if (body.byteLength > input.maxBytes) {
    throw new Error(`tool payload cleanup manifest exceeded ${input.maxBytes} bytes`);
  }
  const digest = await sha256(body);
  const key = `${input.key}.${digest}.json`;
  await withTimeout(
    input.r2.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { archiveBytes: String(body.byteLength), archiveSha256: digest },
    }),
    remainingTimeout(input.timeoutMs, input.deadlineMs, Date.now),
    'tool payload cleanup manifest write timed out'
  );
  const object = await withTimeout(
    input.r2.get(key),
    remainingTimeout(input.timeoutMs, input.deadlineMs, Date.now),
    'tool payload cleanup manifest verification read timed out'
  );
  if (!object) throw new Error('tool payload cleanup manifest verification read was missing');
  const actual = new Uint8Array(
    await withTimeout(
      object.arrayBuffer(),
      remainingTimeout(input.timeoutMs, input.deadlineMs, Date.now),
      'tool payload cleanup manifest verification body read timed out'
    )
  );
  if (actual.byteLength !== body.byteLength || (await sha256(actual)) !== digest) {
    throw new Error('tool payload cleanup manifest verification failed');
  }
  return { value: input.value, key, bytes: body.byteLength, sha256: digest };
}

async function readVerifiedJson<T>(input: {
  parse: (value: unknown) => T;
  r2: R2Bucket;
  key: string;
  expectedSha256: string;
  expectedBytes?: number;
  timeoutMs: number;
  deadlineMs: number;
  maxBytes: number;
  operationBudget?: ToolPayloadArchiveOperationBudget;
  nowMs?: () => number;
}): Promise<T> {
  const nowMs = input.nowMs ?? Date.now;
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
    throw new Error('tool payload cleanup manifest SHA-256 is malformed');
  }
  reserveOperations(input.operationBudget, 2);
  const object = await withTimeout(
    input.r2.get(input.key),
    remainingTimeout(input.timeoutMs, input.deadlineMs, nowMs),
    'tool payload cleanup manifest read timed out'
  );
  if (!object) throw new Error(`tool payload cleanup manifest ${input.key} is missing`);
  const bytes = new Uint8Array(
    await withTimeout(
      object.arrayBuffer(),
      remainingTimeout(input.timeoutMs, input.deadlineMs, nowMs),
      'tool payload cleanup manifest body read timed out'
    )
  );
  if (
    bytes.byteLength > input.maxBytes ||
    bytes.byteLength !== (input.expectedBytes ?? bytes.byteLength)
  ) {
    throw new Error('tool payload cleanup manifest byte verification failed');
  }
  if ((await sha256(bytes)) !== input.expectedSha256) {
    throw new Error('tool payload cleanup manifest SHA-256 verification failed');
  }
  const parsed: unknown = JSON.parse(textDecoder.decode(bytes));
  return input.parse(parsed);
}

function assertSafeInteger(value: unknown, name: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`tool payload cleanup manifest ${name} is invalid`);
  }
}

function assertTarget(value: unknown): asserts value is ProjectDataStorageReliefToolPayloadTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool payload cleanup manifest target is malformed');
  }
  const target = value as Record<string, unknown>;
  assertSafeInteger(target.rowId, 'target rowId', 1);
  assertSafeInteger(target.messageCreatedAt, 'target messageCreatedAt');
  assertSafeInteger(target.messageSequence, 'target messageSequence');
  assertSafeInteger(target.toolMetadataBytes, 'target toolMetadataBytes', 1);
  assertSafeInteger(target.projectedReclaimableBytes, 'target projectedReclaimableBytes', 1);
  if (
    typeof target.sessionId !== 'string' ||
    !target.sessionId ||
    typeof target.messageId !== 'string' ||
    !target.messageId ||
    typeof target.toolMetadataSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(target.toolMetadataSha256)
  ) {
    throw new Error('tool payload cleanup manifest target identity or hash is malformed');
  }
}

/**
 * Envelope + primitive-field guard for the root manifest. Kept as an assertion
 * function so the external JSON payload is narrowed by a runtime guard rather
 * than a blind cast (`.claude/rules/51-runtime-boundary-validation.md`).
 */
function assertRootManifestShape(value: unknown): asserts value is ToolPayloadCleanupManifestRoot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool payload cleanup root manifest is malformed');
  }
  const root = value as Record<string, unknown>;
  if (
    root.version !== TOOL_PAYLOAD_CLEANUP_MANIFEST_VERSION ||
    typeof root.planId !== 'string' ||
    !root.planId ||
    typeof root.projectId !== 'string' ||
    !root.projectId ||
    !Array.isArray(root.batches)
  ) {
    throw new Error('tool payload cleanup root manifest is malformed');
  }
  assertSafeInteger(root.cutoffCreatedAt, 'root cutoffCreatedAt');
  assertSafeInteger(root.createdAt, 'root createdAt');
  assertSafeInteger(root.eligibleRows, 'root eligibleRows');
  assertSafeInteger(root.eligibleBytes, 'root eligibleBytes');
}

/**
 * Envelope + identity guard for a batch manifest, cross-checked against the
 * already verified root manifest and the proof the batch was selected from.
 */
function assertBatchManifestShape(
  value: unknown,
  root: ToolPayloadCleanupManifestRoot,
  proof: ToolPayloadCleanupManifestBatchProof
): asserts value is ToolPayloadCleanupManifestBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool payload cleanup batch manifest identity is invalid');
  }
  const batch = value as Record<string, unknown>;
  if (
    batch.version !== TOOL_PAYLOAD_CLEANUP_MANIFEST_VERSION ||
    batch.planId !== root.planId ||
    batch.projectId !== root.projectId ||
    batch.cutoffCreatedAt !== root.cutoffCreatedAt ||
    batch.ordinal !== proof.ordinal ||
    !Array.isArray(batch.targets) ||
    batch.targets.length !== proof.targetCount
  ) {
    throw new Error('tool payload cleanup batch manifest identity is invalid');
  }
}

export async function writeToolPayloadCleanupManifestBatch(input: {
  r2: R2Bucket;
  archivePrefix: string;
  manifest: ToolPayloadCleanupManifestBatch;
  timeoutMs: number;
  deadlineMs: number;
  maxBytes?: number;
}): Promise<VerifiedManifestObject<ToolPayloadCleanupManifestBatch>> {
  const base = `${normalizePrefix(input.archivePrefix)}/approved-plans/${encodeSegment(input.manifest.projectId)}/${encodeSegment(input.manifest.planId)}/batch-${input.manifest.ordinal}`;
  return writeVerifiedJson({
    ...input,
    key: base,
    value: input.manifest,
    maxBytes: input.maxBytes ?? DEFAULT_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES,
  });
}

export async function writeToolPayloadCleanupManifestRoot(input: {
  r2: R2Bucket;
  archivePrefix: string;
  manifest: ToolPayloadCleanupManifestRoot;
  timeoutMs: number;
  deadlineMs: number;
  maxBytes?: number;
}): Promise<VerifiedManifestObject<ToolPayloadCleanupManifestRoot>> {
  const base = `${normalizePrefix(input.archivePrefix)}/approved-plans/${encodeSegment(input.manifest.projectId)}/${encodeSegment(input.manifest.planId)}/root`;
  return writeVerifiedJson({
    ...input,
    key: base,
    value: input.manifest,
    maxBytes: input.maxBytes ?? DEFAULT_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES,
  });
}

export async function readToolPayloadCleanupManifestRoot(input: {
  r2: R2Bucket;
  key: string;
  sha256: string;
  timeoutMs: number;
  deadlineMs: number;
  operationBudget?: ToolPayloadArchiveOperationBudget;
  nowMs?: () => number;
  maxBytes?: number;
}): Promise<ToolPayloadCleanupManifestRoot> {
  return readVerifiedJson({
    r2: input.r2,
    key: input.key,
    expectedSha256: input.sha256,
    timeoutMs: input.timeoutMs,
    deadlineMs: input.deadlineMs,
    maxBytes: input.maxBytes ?? DEFAULT_TOOL_PAYLOAD_CLEANUP_ROOT_MANIFEST_MAX_BYTES,
    parse: parseCleanupManifestRoot,
    ...(input.operationBudget ? { operationBudget: input.operationBudget } : {}),
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
  });
}

/**
 * Structural parser for the root manifest. `readVerifiedJson` delegates narrowing
 * here so no external payload is ever narrowed by a blind `as` cast
 * (`.claude/rules/51-runtime-boundary-validation.md`).
 */
function parseCleanupManifestRoot(value: unknown): ToolPayloadCleanupManifestRoot {
  assertRootManifestShape(value);
  const root = value;
  let rows = 0;
  let bytes = 0;
  let previousLastRowId = 0;
  root.batches.forEach((batch, index) => {
    assertSafeInteger(batch.ordinal, 'batch ordinal');
    assertSafeInteger(batch.bytes, 'batch bytes', 1);
    assertSafeInteger(batch.targetCount, 'batch targetCount', 1);
    assertSafeInteger(batch.projectedReclaimableBytes, 'batch projectedReclaimableBytes', 1);
    assertSafeInteger(batch.firstRowId, 'batch firstRowId', 1);
    assertSafeInteger(batch.lastRowId, 'batch lastRowId', 1);
    if (
      batch.ordinal !== index ||
      typeof batch.key !== 'string' ||
      !batch.key ||
      typeof batch.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(batch.sha256) ||
      batch.firstRowId <= previousLastRowId ||
      batch.lastRowId < batch.firstRowId
    ) {
      throw new Error('tool payload cleanup root batch proof is malformed');
    }
    rows += batch.targetCount;
    bytes += batch.projectedReclaimableBytes;
    previousLastRowId = batch.lastRowId;
  });
  if (rows !== root.eligibleRows || bytes !== root.eligibleBytes) {
    throw new Error('tool payload cleanup root totals do not match batch proofs');
  }
  return root;
}

export async function readToolPayloadCleanupManifestBatch(input: {
  r2: R2Bucket;
  proof: ToolPayloadCleanupManifestBatchProof;
  root: ToolPayloadCleanupManifestRoot;
  timeoutMs: number;
  deadlineMs: number;
  operationBudget?: ToolPayloadArchiveOperationBudget;
  nowMs?: () => number;
  maxBytes?: number;
}): Promise<ToolPayloadCleanupManifestBatch> {
  return readVerifiedJson({
    r2: input.r2,
    key: input.proof.key,
    expectedSha256: input.proof.sha256,
    expectedBytes: input.proof.bytes,
    timeoutMs: input.timeoutMs,
    deadlineMs: input.deadlineMs,
    maxBytes: input.maxBytes ?? DEFAULT_TOOL_PAYLOAD_CLEANUP_BATCH_MANIFEST_MAX_BYTES,
    parse: (value) => parseCleanupManifestBatch(value, input.root, input.proof),
    ...(input.operationBudget ? { operationBudget: input.operationBudget } : {}),
    ...(input.nowMs ? { nowMs: input.nowMs } : {}),
  });
}

/**
 * Structural parser for a batch manifest, cross-checked against the already
 * verified root manifest and the batch proof it was selected from.
 */
function parseCleanupManifestBatch(
  value: unknown,
  root: ToolPayloadCleanupManifestRoot,
  proof: ToolPayloadCleanupManifestBatchProof
): ToolPayloadCleanupManifestBatch {
  assertBatchManifestShape(value, root, proof);
  const batch = value;
  let projectedBytes = 0;
  let previousRowId = 0;
  for (const target of batch.targets) {
    assertTarget(target);
    if (target.rowId <= previousRowId) {
      throw new Error('tool payload cleanup batch targets are not strictly ordered');
    }
    previousRowId = target.rowId;
    projectedBytes += target.projectedReclaimableBytes;
  }
  if (projectedBytes !== proof.projectedReclaimableBytes) {
    throw new Error('tool payload cleanup batch projected bytes do not match proof');
  }
  if (
    batch.targets[0]?.rowId !== proof.firstRowId ||
    batch.targets.at(-1)?.rowId !== proof.lastRowId
  ) {
    throw new Error('tool payload cleanup batch row bounds do not match proof');
  }
  return batch;
}
