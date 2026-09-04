import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { toolPayloadStorageReliefRawWindowQuery } from '../../src/durable-objects/project-data/storage-relief-measurement';
import {
  classifyStorageUsage,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS,
  resolveStorageSafetyConfig,
} from '../../src/durable-objects/project-data/storage-safety';
import { runProjectDataToolPayloadCleanup } from '../../src/durable-objects/project-data/tool-payload-cleanup';
import {
  writeToolPayloadCleanupManifestBatch,
  writeToolPayloadCleanupManifestRoot,
} from '../../src/durable-objects/project-data/tool-payload-cleanup-manifest';
import { runProjectDataManualToolPayloadCleanup } from '../../src/durable-objects/project-data/tool-payload-manual-cleanup';
import type { Env as WorkerEnv } from '../../src/env';
import { storeMcpToken } from '../../src/services/mcp-token';
import { measureProjectDataStorageRelief } from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const TEST_PREFIX = `tool-payload-archive-${Date.now()}`;

type RuntimeEnvOverride = Partial<WorkerEnv> & Record<string, unknown>;

type ArchiveRow = {
  message_id: string;
  session_id: string;
  r2_key: string;
  content_bytes: number;
  tool_metadata_bytes: number;
  archived_at: number;
  message_created_at: number;
  message_sequence: number;
  archive_version: number;
  archive_body_bytes: number | null;
  archive_body_sha256: string | null;
  root_object_bytes: number | null;
  root_object_sha256: string | null;
  verified_object_count: number | null;
};

type JsonRpcToolResponse = {
  jsonrpc: '2.0';
  id: string;
  result?: {
    content?: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
};

function getStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<{ userId: string }> {
  const suffix = projectId.replaceAll(/[^a-zA-Z0-9-]/g, '-');
  const userId = `${suffix}-owner`;
  const installationId = `${suffix}-installation`;
  await seedUser(userId, { githubId: `${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${suffix}-external-installation`,
    accountName: `${suffix}-account`,
  });
  await seedProject(projectId, userId, installationId, {
    name: `Tool Payload Archive ${suffix}`,
    repository: `${suffix}/repo`,
  });
  return { userId };
}

function makeToolMetadata(label: string, payloadBytes = 1024): string {
  return JSON.stringify({
    toolCallId: `tool-${label}`,
    title: `Tool ${label}`,
    status: 'completed',
    content: [{ type: 'text', text: `${label}:${'x'.repeat(payloadBytes)}` }],
  });
}

function makeToolMetadataWithoutContent(label: string): string {
  return JSON.stringify({
    toolCallId: `tool-${label}`,
    title: `Tool ${label}`,
    status: 'completed',
    summary: `metadata only ${label}`,
  });
}

async function withRuntimeEnv<T>(overrides: RuntimeEnvOverride, fn: () => Promise<T>): Promise<T> {
  const mutableEnv = testEnv as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, mutableEnv[key]);
    mutableEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete mutableEnv[key];
      else mutableEnv[key] = value;
    }
  }
}

async function seedToolMessages(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  messages: Array<{ id: string; createdAt: number; sequence: number; payloadBytes?: number }>
): Promise<{ sessionId: string; messageIds: string[] }> {
  return runInDurableObject(stub, async (instance, state) => {
    const sessionId = await instance.createSession(null, 'Archived tool payload test');
    const messageIds: string[] = [];
    for (const message of messages) {
      const messageId = await instance.persistMessage(
        sessionId,
        'tool',
        `visible ${message.id}`,
        makeToolMetadata(message.id, message.payloadBytes),
        `tool-${message.id}`
      );
      state.storage.sql.exec(
        'UPDATE chat_messages SET created_at = ?, sequence = ? WHERE id = ?',
        message.createdAt,
        message.sequence,
        messageId
      );
      messageIds.push(messageId);
    }
    return { sessionId, messageIds };
  });
}

async function runArchiveCleanup(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  projectId: string,
  overrides: RuntimeEnvOverride,
  options: { now?: number; nowMs?: () => number } = {}
) {
  return withRuntimeEnv(overrides, async () =>
    runInDurableObject(stub, async (_instance, state) => {
      const config = resolveStorageSafetyConfig(testEnv);
      return runProjectDataToolPayloadCleanup(state.storage.sql, testEnv, projectId, config, {
        allowStart: true,
        now: options.now ?? FIXED_NOW,
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        transactionSync: (callback) => state.storage.transactionSync(callback),
        classifyStatus: (databaseSizeBytes) => classifyStorageUsage(databaseSizeBytes, config),
        recordTelemetry: async () => undefined,
      });
    })
  );
}

async function approvedCleanupEnv(
  projectId: string,
  planId: string,
  cutoffCreatedAt: number
): Promise<RuntimeEnvOverride> {
  const measured = await measureProjectDataStorageRelief(testEnv, projectId, {
    limit: 5_000,
    surface: 'tool_payloads',
    cutoffCreatedAt,
    maxEligibleBytes: 10_000_000,
    deadlineMs: Date.now() + 10_000,
  });
  const batch = await writeToolPayloadCleanupManifestBatch({
    r2: env.PROJECT_DATA_ARCHIVE_R2,
    archivePrefix: 'project-data/tool-payloads',
    manifest: {
      version: 1,
      planId,
      projectId,
      cutoffCreatedAt,
      ordinal: 0,
      targets: measured.toolPayloads.targets,
    },
    timeoutMs: 5_000,
    deadlineMs: Date.now() + 10_000,
  });
  const root = await writeToolPayloadCleanupManifestRoot({
    r2: env.PROJECT_DATA_ARCHIVE_R2,
    archivePrefix: 'project-data/tool-payloads',
    manifest: {
      version: 1,
      planId,
      projectId,
      cutoffCreatedAt,
      createdAt: FIXED_NOW,
      eligibleRows: measured.toolPayloads.eligibleRows,
      eligibleBytes: measured.toolPayloads.eligibleBytes,
      batches: [
        {
          ordinal: 0,
          key: batch.key,
          bytes: batch.bytes,
          sha256: batch.sha256,
          targetCount: measured.toolPayloads.eligibleRows,
          projectedReclaimableBytes: measured.toolPayloads.eligibleBytes,
          firstRowId: measured.toolPayloads.targets[0]!.rowId,
          lastRowId: measured.toolPayloads.targets.at(-1)!.rowId,
        },
      ],
    },
    timeoutMs: 5_000,
    deadlineMs: Date.now() + 10_000,
  });
  return {
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID: planId,
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: projectId,
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: String(cutoffCreatedAt),
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY: root.key,
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256: root.sha256,
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS: String(measured.toolPayloads.eligibleRows),
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES: String(measured.toolPayloads.eligibleBytes),
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS: '100000',
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS: '100000',
  };
}

async function runManualCleanup(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  projectId: string,
  overrides: RuntimeEnvOverride,
  input: Parameters<typeof runProjectDataManualToolPayloadCleanup>[3]
) {
  return withRuntimeEnv(overrides, async () =>
    runInDurableObject(stub, async (_instance, state) =>
      runProjectDataManualToolPayloadCleanup(state.storage.sql, testEnv, projectId, input, {
        transactionSync: (callback) => state.storage.transactionSync(callback),
      })
    )
  );
}

async function readMessageMetadata(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  messageIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  return runInDurableObject(stub, async (_instance, state) => {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = state.storage.sql
      .exec(
        `SELECT id, tool_metadata
         FROM chat_messages
         WHERE id IN (${placeholders})
         ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC`,
        ...messageIds
      )
      .toArray() as Array<{ id: string; tool_metadata: string }>;
    return new Map(
      rows.map((row) => [row.id, JSON.parse(row.tool_metadata) as Record<string, unknown>])
    );
  });
}

async function readMessageContentAndMetadata(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  messageIds: string[]
): Promise<Map<string, { content: string; toolMetadata: Record<string, unknown> }>> {
  return runInDurableObject(stub, async (_instance, state) => {
    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = state.storage.sql
      .exec(
        `SELECT id, content, tool_metadata
         FROM chat_messages
         WHERE id IN (${placeholders})
         ORDER BY created_at ASC, COALESCE(sequence, 0) ASC, id ASC`,
        ...messageIds
      )
      .toArray() as Array<{ id: string; content: string; tool_metadata: string }>;
    return new Map(
      rows.map((row) => [
        row.id,
        {
          content: row.content,
          toolMetadata: JSON.parse(row.tool_metadata) as Record<string, unknown>,
        },
      ])
    );
  });
}

async function readArchiveRows(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  messageIds: string[]
): Promise<ArchiveRow[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const placeholders = messageIds.map(() => '?').join(', ');
    return state.storage.sql
      .exec(
        `SELECT
           message_id,
           session_id,
           r2_key,
           content_bytes,
           tool_metadata_bytes,
           archived_at,
           message_created_at,
           message_sequence,
           archive_version,
           archive_body_bytes,
           archive_body_sha256,
           root_object_bytes,
           root_object_sha256,
           verified_object_count
         FROM tool_payload_archives
         WHERE message_id IN (${placeholders})
         ORDER BY message_created_at ASC, message_sequence ASC, message_id ASC`,
        ...messageIds
      )
      .toArray() as ArchiveRow[];
  });
}

/**
 * Shared assertion for the "source is untouched" invariant: visible message text
 * is preserved byte-for-byte, the inline tool payload is still present, and no
 * archive row was published. Used by every fail-closed case.
 */
async function expectSourcePayloadIntact(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  seeded: { messageIds: string[] },
  label: string
): Promise<void> {
  const source = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
    seeded.messageIds[0]!
  );
  expect(source?.content).toBe(`visible ${label}`);
  expect(Array.isArray(source?.toolMetadata.content)).toBe(true);
  expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
}

/**
 * Shared assertion for the success invariant: visible message text is preserved
 * byte-for-byte while the inline tool payload has been stripped and exactly one
 * verified archive row exists.
 */
async function expectSourcePayloadArchived(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  seeded: { messageIds: string[] },
  label: string
): Promise<void> {
  const source = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
    seeded.messageIds[0]!
  );
  expect(source?.content).toBe(`visible ${label}`);
  expect(source?.toolMetadata.content).toBeUndefined();
  expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);
}

/**
 * Builds an R2 double whose FIRST tool-payload put blocks until released, so a
 * test can hold one cleanup pass inside its external await and prove a second,
 * overlapping pass is serialized behind the shared mutex (rule 45). Approved-plan
 * manifest puts are excluded so plan setup is never gated.
 */
function makePayloadPutGate(): {
  firstPayloadPutStarted: Promise<void>;
  releaseFirstPayloadPut: () => void;
  delayedR2: R2Bucket;
  readonly payloadPuts: number;
} {
  const realR2 = env.PROJECT_DATA_ARCHIVE_R2;
  let payloadPuts = 0;
  let markFirstPayloadPutStarted!: () => void;
  let releaseFirstPayloadPut!: () => void;
  const firstPayloadPutStarted = new Promise<void>((resolve) => {
    markFirstPayloadPutStarted = resolve;
  });
  const firstPayloadPutRelease = new Promise<void>((resolve) => {
    releaseFirstPayloadPut = resolve;
  });
  const delayedR2 = {
    put: async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
      if (!key.includes('/approved-plans/')) {
        payloadPuts += 1;
        if (payloadPuts === 1) {
          markFirstPayloadPutStarted();
          await firstPayloadPutRelease;
        }
      }
      return realR2.put(key, value);
    },
    get: (key: string) => realR2.get(key),
  } as unknown as R2Bucket;
  return {
    firstPayloadPutStarted,
    releaseFirstPayloadPut: () => releaseFirstPayloadPut(),
    delayedR2,
    get payloadPuts() {
      return payloadPuts;
    },
  };
}

async function readCleanupAttempts(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  messageIds: string[]
): Promise<Array<{ message_id: string; status: string; failure_count: number }>> {
  return runInDurableObject(stub, async (_instance, state) => {
    const placeholders = messageIds.map(() => '?').join(', ');
    return state.storage.sql
      .exec(
        `SELECT message_id, status, failure_count
         FROM tool_payload_cleanup_attempts
         WHERE message_id IN (${placeholders})
         ORDER BY message_id ASC`,
        ...messageIds
      )
      .toArray() as Array<{ message_id: string; status: string; failure_count: number }>;
  });
}

async function callMcpTool(
  token: string,
  name: string,
  args: Record<string, unknown>
): Promise<JsonRpcToolResponse> {
  const response = await SELF.fetch('https://api.test.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-request`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  expect(response.status).toBe(200);
  return response.json<JsonRpcToolResponse>();
}

describe('ProjectData tool payload R2 archival', () => {
  it('runs one manual project-scoped cleanup pass with auto cleanup disabled, idempotency, and cooldown', async () => {
    const projectId = `${TEST_PREFIX}-manual-control`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manual-1', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'manual-2', createdAt: FIXED_NOW - 2_000, sequence: 2 },
    ]);

    const first = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS: '86400000',
      },
      {
        reason: 'operator incident relief',
        idempotencyKey: 'manual-key-1',
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW,
        nowMs: () => FIXED_NOW,
      }
    );

    expect(first).toMatchObject({
      projectId,
      reason: 'operator incident relief',
      idempotencyKey: 'manual-key-1',
      idempotent: false,
      attempted: true,
      skipReason: null,
      cooldown: {
        active: true,
        nextAllowedAt: FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS,
      },
      telemetry: {
        rowsScanned: 1,
        rowsUpdated: 1,
        rowsFailed: 0,
        terminationReason: 'row_budget',
      },
    });
    expect(first.telemetry.beforeBytes).toBe(first.cleanup?.beforeBytes);
    expect(first.telemetry.afterBytes).toBe(first.cleanup?.afterBytes);
    expect(first.telemetry.reclaimedBytes).toBe(
      Math.max(first.telemetry.beforeBytes - first.telemetry.afterBytes, 0)
    );

    const afterFirst = await readMessageContentAndMetadata(stub, seeded.messageIds);
    expect(afterFirst.get(seeded.messageIds[0]!)?.content).toBe('visible manual-1');
    expect(afterFirst.get(seeded.messageIds[0]!)?.toolMetadata.content).toBeUndefined();
    expect(Array.isArray(afterFirst.get(seeded.messageIds[1]!)?.toolMetadata.content)).toBe(true);

    const replay = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
      },
      {
        reason: 'operator incident relief',
        idempotencyKey: 'manual-key-1',
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW + 1_000,
        nowMs: () => FIXED_NOW + 1_000,
      }
    );
    expect(replay.idempotent).toBe(true);
    expect(replay.telemetry.rowsUpdated).toBe(1);
    expect(
      (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)
        ?.content
    ).toBe('visible manual-1');
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);

    const differentKeyDuringCooldown = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
      },
      {
        reason: 'operator incident relief retry',
        idempotencyKey: 'manual-key-2',
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW + 5 * 60 * 1000,
        nowMs: () => FIXED_NOW + 5 * 60 * 1000,
      }
    );
    expect(differentKeyDuringCooldown).toMatchObject({
      idempotent: false,
      attempted: false,
      skipReason: 'cooldown',
      telemetry: { terminationReason: 'cooldown', rowsUpdated: 0 },
      cooldown: {
        active: true,
        nextAllowedAt: FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS,
      },
    });
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);

    const afterCooldown = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
      },
      {
        reason: 'operator incident relief after cooldown',
        idempotencyKey: 'manual-key-3',
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS + 1,
        nowMs: () => FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS + 1,
      }
    );
    expect(afterCooldown).toMatchObject({
      attempted: true,
      telemetry: { rowsScanned: 1, rowsUpdated: 1 },
    });
    const afterFinal = await readMessageContentAndMetadata(stub, seeded.messageIds);
    expect(afterFinal.get(seeded.messageIds[0]!)?.content).toBe('visible manual-1');
    expect(afterFinal.get(seeded.messageIds[1]!)?.content).toBe('visible manual-2');
    expect(afterFinal.get(seeded.messageIds[1]!)?.toolMetadata.content).toBeUndefined();
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(2);
  });

  it('retries a crashed manual cleanup with the same idempotency key after cooldown', async () => {
    const projectId = `${TEST_PREFIX}-manual-crash-retry`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manual-crash-retry', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const reason = 'operator crash retry';
    const idempotencyKey = 'manual-crash-key';
    const recheckMs = 10_000;
    const nextAllowedAt = FIXED_NOW + recheckMs;

    await runInDurableObject(stub, async (_instance, state) => {
      const fingerprint = JSON.stringify({
        reason,
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
      });
      const writeMeta = (key: string, value: string): void => {
        state.storage.sql.exec(
          `INSERT INTO do_meta (key, value)
           VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          value
        );
      };
      writeMeta('storageSafetyToolPayloadManualCleanupIdempotencyKey', idempotencyKey);
      writeMeta('storageSafetyToolPayloadManualCleanupFingerprint', fingerprint);
      writeMeta('storageSafetyToolPayloadManualCleanupReason', reason);
      writeMeta('storageSafetyToolPayloadManualCleanupStartedAt', String(FIXED_NOW));
      writeMeta('storageSafetyToolPayloadManualCleanupNextAllowedAt', String(nextAllowedAt));
      state.storage.sql.exec(
        'DELETE FROM do_meta WHERE key = ?',
        'storageSafetyToolPayloadManualCleanupResultJson'
      );
    });

    const duringCooldown = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS: String(recheckMs),
      },
      {
        reason,
        idempotencyKey,
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW + 1_000,
        nowMs: () => FIXED_NOW + 1_000,
      }
    );
    expect(duringCooldown).toMatchObject({
      attempted: false,
      skipReason: 'idempotency_in_progress',
      telemetry: { terminationReason: 'idempotency_in_progress', rowsUpdated: 0 },
      cooldown: { active: true, nextAllowedAt },
    });
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);

    const retryNow = nextAllowedAt + 1;
    const afterCooldown = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_RECHECK_MS: String(recheckMs),
      },
      {
        reason,
        idempotencyKey,
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: retryNow,
        nowMs: () => retryNow,
      }
    );
    expect(afterCooldown).toMatchObject({
      attempted: true,
      skipReason: null,
      telemetry: { rowsScanned: 1, rowsUpdated: 1, rowsFailed: 0 },
      cooldown: { active: true, nextAllowedAt: retryNow + recheckMs },
    });
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);
  });

  it('enforces manual cleanup env-backed hard budgets inside the ProjectData DO', async () => {
    const projectId = `${TEST_PREFIX}-manual-budget-max`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manual-budget', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);

    const captured = await withRuntimeEnv(
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_MANUAL_CLEANUP_MAX_BATCH_ROWS: '1',
      },
      () =>
        runInDurableObject(stub, async (_instance, state) => {
          try {
            await runProjectDataManualToolPayloadCleanup(
              state.storage.sql,
              testEnv,
              projectId,
              {
                reason: 'operator over budget',
                idempotencyKey: 'budget-key',
                batchRows: 2,
                now: FIXED_NOW,
              },
              {
                transactionSync: (callback) => state.storage.transactionSync(callback),
              }
            );
            return { threw: false };
          } catch (error) {
            return {
              threw: true,
              name: error instanceof Error ? error.name : 'Error',
              message: error instanceof Error ? error.message : String(error),
            };
          }
        })
    );

    expect(captured).toEqual({
      threw: true,
      name: 'ProjectDataManualToolPayloadCleanupStateError',
      message: 'batchRows must be between 1 and 1',
    });
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('manual cleanup preserves raw text and inline payload content when archive verification fails', async () => {
    const projectId = `${TEST_PREFIX}-manual-r2-fail`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manual-r2-failure', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const failingR2 = {
      put: async () => {
        throw new Error('forced manual R2 failure');
      },
    } as unknown as R2Bucket;

    const result = await runManualCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_ARCHIVE_R2: failingR2,
      },
      {
        reason: 'operator R2 failure canary',
        idempotencyKey: 'manual-r2-fail-key',
        batchRows: 1,
        batchBytes: 1_000_000,
        wallTimeMs: 20_000,
        now: FIXED_NOW,
        nowMs: () => FIXED_NOW,
      }
    );

    expect(result).toMatchObject({
      attempted: true,
      telemetry: {
        rowsScanned: 1,
        rowsUpdated: 0,
        rowsFailed: 1,
        terminationReason: 'error',
      },
      cooldown: {
        active: true,
      },
    });
    const row = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(row?.content).toBe('visible manual-r2-failure');
    expect(Array.isArray(row?.toolMetadata.content)).toBe(true);
    expect(row?.toolMetadata.toolPayloadArchive).toBeUndefined();
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('fails closed when the R2 archive write fails', async () => {
    const projectId = `${TEST_PREFIX}-atomicity`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const oldCreatedAt = FIXED_NOW - 1_000;
    const seeded = await seedToolMessages(stub, [
      { id: 'r2-failure', createdAt: oldCreatedAt, sequence: 1 },
    ]);
    const failingR2 = {
      put: async () => {
        throw new Error('forced R2 write failure');
      },
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_ARCHIVE_R2: failingR2,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    expect(result?.recheckAt).toBe(
      FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    );
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('limits automatic cleanup to the configured project allowlist without blocking manual cleanup', async () => {
    const projectId = `${TEST_PREFIX}-allowlist-excluded`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'allowlist-excluded', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const overrides = {
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: 'some-other-project',
    };

    const automatic = await runArchiveCleanup(stub, projectId, overrides, {
      now: FIXED_NOW,
      nowMs: () => FIXED_NOW,
    });
    expect(automatic).toBeNull();
    expect(
      Array.isArray(
        (await readMessageMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)?.content
      )
    ).toBe(true);

    const manual = await runManualCleanup(stub, projectId, overrides, {
      reason: 'operator-approved scoped cleanup',
      idempotencyKey: 'allowlist-manual-cleanup',
      batchRows: 1,
      batchBytes: 1_000_000,
      wallTimeMs: 20_000,
      now: FIXED_NOW,
      nowMs: () => FIXED_NOW,
    });
    expect(manual.telemetry.rowsUpdated).toBe(1);
    expect(
      (await readMessageMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)?.content
    ).toBeUndefined();
  });

  it('preflight reports net reclaimable bytes for exactly the payloads cleanup can strip', async () => {
    const projectId = `${TEST_PREFIX}-net-relief-measurement`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'valid', createdAt: FIXED_NOW - 4_000, sequence: 1 },
      { id: 'empty', createdAt: FIXED_NOW - 3_000, sequence: 2 },
      { id: 'scalar', createdAt: FIXED_NOW - 2_000, sequence: 3 },
      { id: 'malformed', createdAt: FIXED_NOW - 1_000, sequence: 4 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        JSON.stringify({ content: [] }),
        seeded.messageIds[1]
      );
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        JSON.stringify({ content: 'not-an-array' }),
        seeded.messageIds[2]
      );
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        '{"content": [malformed}',
        seeded.messageIds[3]
      );
    });

    const measurement = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 10,
    });
    expect(measurement.toolPayloads).toMatchObject({
      rowsExamined: 4,
      eligibleRows: 1,
      skippedRows: 3,
    });
    const validBytesBefore = await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT length(CAST(tool_metadata AS BLOB)) AS bytes FROM chat_messages WHERE id = ?',
          seeded.messageIds[0]
        )
        .toArray()[0] as { bytes: number };
      return row.bytes;
    });

    const cleanup = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(cleanup?.rowsUpdated).toBe(1);
    const validBytesAfter = await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT length(CAST(tool_metadata AS BLOB)) AS bytes FROM chat_messages WHERE id = ?',
          seeded.messageIds[0]
        )
        .toArray()[0] as { bytes: number };
      return row.bytes;
    });
    expect(measurement.toolPayloads.eligibleBytes).toBe(validBytesBefore - validBytesAfter);
    const contents = await runInDurableObject(stub, async (_instance, state) => {
      const placeholders = seeded.messageIds.map(() => '?').join(', ');
      return new Map(
        (
          state.storage.sql
            .exec(
              `SELECT id, content FROM chat_messages WHERE id IN (${placeholders})`,
              ...seeded.messageIds
            )
            .toArray() as Array<{ id: string; content: string }>
        ).map((row) => [row.id, row.content])
      );
    });
    for (const [index, messageId] of seeded.messageIds.entries()) {
      expect(contents.get(messageId)).toBe(
        `visible ${['valid', 'empty', 'scalar', 'malformed'][index]}`
      );
    }
  });

  it('measures ready retry and rearchivable oversized rows using their actual net relief', async () => {
    const projectId = `${TEST_PREFIX}-retry-net-relief`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'ready-retry', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'deferred-retry', createdAt: FIXED_NOW - 2_000, sequence: 2 },
      { id: 'rearchivable', createdAt: FIXED_NOW - 1_000, sequence: 3 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      for (const [index, status, nextAttemptAt] of [
        [0, 'retryable_failure', FIXED_NOW - 1],
        [1, 'retryable_failure', Date.UTC(2030, 0, 1)],
        [2, 'oversized', null],
      ] as const) {
        state.storage.sql.exec(
          `INSERT INTO tool_payload_cleanup_attempts
             (message_id, status, failure_count, next_attempt_at, last_attempt_at,
              last_error, message_created_at, message_sequence)
           VALUES (?, ?, 1, ?, ?, 'seeded', ?, ?)`,
          seeded.messageIds[index],
          status,
          nextAttemptAt,
          FIXED_NOW - 100,
          FIXED_NOW - (3 - index) * 1_000,
          index + 1
        );
      }
    });
    const before = await runInDurableObject(
      stub,
      async (_instance, state) =>
        new Map(
          (
            state.storage.sql
              .exec(
                `SELECT id, length(CAST(tool_metadata AS BLOB)) AS bytes
               FROM chat_messages WHERE id IN (?, ?, ?)`,
                ...seeded.messageIds
              )
              .toArray() as Array<{ id: string; bytes: number }>
          ).map((row) => [row.id, row.bytes])
        )
    );
    const measurement = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 100,
      maxEligibleBytes: 1_000_000,
      deadlineMs: Date.now() + 10_000,
    });
    expect(measurement.toolPayloads).toMatchObject({
      eligibleRows: 2,
      rearchivableOversizedRows: 1,
      skippedRows: 1,
    });
    expect(measurement.toolPayloads.targets.map((target) => target.messageId)).toEqual([
      seeded.messageIds[0],
      seeded.messageIds[2],
    ]);

    const cleanup = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(cleanup?.rowsUpdated).toBe(2);
    const after = await runInDurableObject(
      stub,
      async (_instance, state) =>
        new Map(
          (
            state.storage.sql
              .exec(
                `SELECT id, length(CAST(tool_metadata AS BLOB)) AS bytes
               FROM chat_messages WHERE id IN (?, ?, ?)`,
                ...seeded.messageIds
              )
              .toArray() as Array<{ id: string; bytes: number }>
          ).map((row) => [row.id, row.bytes])
        )
    );
    for (const target of measurement.toolPayloads.targets) {
      expect(target.projectedReclaimableBytes).toBe(
        before.get(target.messageId)! - after.get(target.messageId)!
      );
    }
    expect(measurement.toolPayloads.rearchivableOversizedBytes).toBe(
      measurement.toolPayloads.targets[1]!.projectedReclaimableBytes
    );
    expect(after.get(seeded.messageIds[1]!)).toBe(before.get(seeded.messageIds[1]!));
  });

  it('enforces the real preflight byte and inner-deadline boundaries', async () => {
    const projectId = `${TEST_PREFIX}-preflight-boundaries`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'boundary-first', createdAt: FIXED_NOW - 2_000, sequence: 1 },
      { id: 'boundary-second', createdAt: FIXED_NOW - 1_000, sequence: 2 },
    ]);
    const baseline = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 100,
      maxEligibleBytes: 1_000_000,
      deadlineMs: Date.now() + 10_000,
    });
    const firstBytes = baseline.toolPayloads.targets[0]!.projectedReclaimableBytes;
    const byteBounded = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 100,
      maxEligibleBytes: firstBytes - 1,
      deadlineMs: Date.now() + 10_000,
    });
    expect(byteBounded.toolPayloads).toMatchObject({
      eligibleRows: 0,
      eligibleBytes: 0,
      byteLimitReached: true,
      hasMore: true,
    });
    const timedOut = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 1,
      maxEligibleBytes: 1_000_000,
      deadlineMs: 0,
    });
    expect(timedOut.toolPayloads).toMatchObject({
      rowsExamined: 0,
      deadlineReached: true,
      hasMore: true,
    });
    const retried = await measureProjectDataStorageRelief(testEnv, projectId, {
      surface: 'tool_payloads',
      cutoffCreatedAt: FIXED_NOW,
      limit: 1,
      maxEligibleBytes: 1_000_000,
      deadlineMs: Date.now() + 10_000,
    });
    expect(retried.toolPayloads.rowsExamined).toBe(1);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('uses an index search rather than a prefix scan for resumed preflight slices', async () => {
    const projectId = `${TEST_PREFIX}-preflight-query-plan`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const cursor = {
      rowId: 1,
      sessionId: 'session-a',
      createdAt: FIXED_NOW - 1_000,
      sequence: 1,
      messageId: 'message-a',
    };
    const query = toolPayloadStorageReliefRawWindowQuery(cursor);
    const details = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql
        .exec(`EXPLAIN QUERY PLAN ${query.sql}`, ...query.params, 10)
        .toArray()
        .map((row) => String((row as { detail?: string }).detail ?? ''))
    );
    expect(
      details.some((detail) => detail.includes('SEARCH chat_messages USING INTEGER PRIMARY KEY'))
    ).toBe(true);
    expect(details.some((detail) => detail.includes('SCAN chat_messages'))).toBe(false);
  });

  it('limits automatic cleanup to the configured fixed creation cutoff', async () => {
    const projectId = `${TEST_PREFIX}-fixed-cutoff`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'before-fixed-cutoff', createdAt: FIXED_NOW - 2_000, sequence: 1 },
      { id: 'after-fixed-cutoff', createdAt: FIXED_NOW - 1_000, sequence: 2 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'fixed-cutoff-test-plan',
      FIXED_NOW - 1_500
    );

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        ...approval,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(metadata.get(seeded.messageIds[0]!)?.content).toBeUndefined();
    expect(Array.isArray(metadata.get(seeded.messageIds[1]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);
  });

  it('serializes overlapping storage-safety cleanup passes across external R2 awaits', async () => {
    const projectId = `${TEST_PREFIX}-overlapping-cleanup-mutex`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'overlapping-cleanup-mutex', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'overlapping-cleanup-mutex-plan',
      FIXED_NOW - 1_000
    );
    const gate = makePayloadPutGate();
    const { firstPayloadPutStarted, releaseFirstPayloadPut, delayedR2 } = gate;

    await withRuntimeEnv(
      {
        ...approval,
        PROJECT_DATA_ARCHIVE_R2: delayedR2,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      },
      async () =>
        runInDurableObject(stub, async (instance, state) => {
          const first = instance.runStorageSafetyAlarmForTest();
          await firstPayloadPutStarted;
          const second = instance.runStorageSafetyAlarmForTest();

          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(gate.payloadPuts).toBe(1);
            expect(
              Number(
                (
                  state.storage.sql
                    .exec(
                      "SELECT value FROM do_meta WHERE key = 'storageSafetyToolCleanupTotalR2Operations'"
                    )
                    .one() as { value: string }
                ).value
              )
            ).toBe(1500);
          } finally {
            releaseFirstPayloadPut();
          }
          await Promise.all([first, second]);
        })
    );

    expect(gate.payloadPuts).toBe(1);
    await expectSourcePayloadArchived(stub, seeded, 'overlapping-cleanup-mutex');
  });

  it('serializes manual cleanup behind storage-safety cleanup across an external R2 await', async () => {
    const projectId = `${TEST_PREFIX}-manual-automatic-cleanup-mutex`;
    await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manual-automatic-cleanup-mutex', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manual-automatic-cleanup-mutex-plan',
      FIXED_NOW - 1_000
    );
    const gate = makePayloadPutGate();
    const { firstPayloadPutStarted, releaseFirstPayloadPut, delayedR2 } = gate;

    await withRuntimeEnv(
      {
        ...approval,
        PROJECT_DATA_ARCHIVE_R2: delayedR2,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'true',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'false',
        PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED: 'false',
      },
      async () =>
        runInDurableObject(stub, async (instance) => {
          const automatic = instance.runStorageSafetyAlarmForTest();
          await firstPayloadPutStarted;
          let manualSettled = false;
          const manual = instance
            .runManualToolPayloadCleanup({
              reason: 'mutex overlap proof',
              idempotencyKey: 'manual-automatic-cleanup-mutex',
              batchRows: 1,
              batchBytes: 1_000_000,
              wallTimeMs: 20_000,
              now: FIXED_NOW,
              nowMs: () => FIXED_NOW,
            })
            .then((result) => {
              manualSettled = true;
              return result;
            });

          try {
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(gate.payloadPuts).toBe(1);
            expect(manualSettled).toBe(false);
          } finally {
            releaseFirstPayloadPut();
          }
          const [, manualResult] = await Promise.all([automatic, manual]);
          expect(manualResult.telemetry.rowsUpdated).toBe(0);
          expect(manualResult.skipReason).toBe('not_needed');
        })
    );

    expect(gate.payloadPuts).toBe(1);
    await expectSourcePayloadArchived(stub, seeded, 'manual-automatic-cleanup-mutex');
  });

  it('fails closed when a fixed cutoff has no exact project allowlist and plan id', async () => {
    const projectId = `${TEST_PREFIX}-fixed-cutoff-unscoped`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-cutoff-unscoped', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: String(FIXED_NOW - 1_000),
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result).toBeNull();
    const before = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(before?.content).toBe('visible fixed-cutoff-unscoped');
    expect(Array.isArray(before?.toolMetadata.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('safely supersedes the pre-plan v2 cleanup cursor with an exact approved manifest', async () => {
    const projectId = `${TEST_PREFIX}-fixed-plan-v2-cursor`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-plan-v2-cursor', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'fixed-plan-v2-cursor-plan',
      FIXED_NOW - 1_000
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const writeMeta = (key: string, value: string): void => {
        state.storage.sql.exec(
          `INSERT INTO do_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          key,
          value
        );
      };
      writeMeta('storageSafetyToolCleanupCursorVersion', '2');
      writeMeta('storageSafetyToolCleanupCursorSessionId', seeded.sessionId);
      writeMeta('storageSafetyToolCleanupCursorCreatedAt', String(FIXED_NOW - 2_000));
      writeMeta('storageSafetyToolCleanupCursorSequence', '1');
      writeMeta('storageSafetyToolCleanupCursorMessageId', seeded.messageIds[0]!);
      writeMeta('storageSafetyToolCleanupRecheckAt', String(FIXED_NOW - 1));
    });

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toMatchObject({ rowsUpdated: 1, rowsFailed: 0 });
    await expectSourcePayloadArchived(stub, seeded, 'fixed-plan-v2-cursor');
  });

  it('fails closed for a manifest-bound fixed plan with reversed cleanup ratios', async () => {
    const projectId = `${TEST_PREFIX}-fixed-ratio-order`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-ratio-order', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'fixed-ratio-order-plan',
      FIXED_NOW - 1_000
    );
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.8',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.9',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toBeNull();
    const source = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(source?.content).toBe('visible fixed-ratio-order');
    expect(Array.isArray(source?.toolMetadata.content)).toBe(true);
  });

  it('does not start a fresh exact plan when the object is already at or below target', async () => {
    const projectId = `${TEST_PREFIX}-fixed-plan-below-target`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-plan-below-target', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'fixed-plan-below-target-plan',
      FIXED_NOW - 1_000
    );

    expect(
      await runArchiveCleanup(
        stub,
        projectId,
        {
          ...approval,
          PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.9',
          PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.82',
        },
        {
          now: FIXED_NOW,
          nowMs: () => FIXED_NOW,
        }
      )
    ).toBeNull();
    await expectSourcePayloadIntact(stub, seeded, 'fixed-plan-below-target');
    const payloadObjects = await env.PROJECT_DATA_ARCHIVE_R2.list({
      prefix: `project-data/tool-payloads/${encodeURIComponent(projectId)}/${encodeURIComponent(seeded.sessionId)}/`,
    });
    expect(payloadObjects.objects).toHaveLength(0);
  });

  it('rejects an exact plan whose per-row ceiling exceeds its per-pass byte ceiling', async () => {
    const projectId = `${TEST_PREFIX}-fixed-plan-row-over-pass`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-plan-row-over-pass', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'fixed-plan-row-over-pass-plan',
      FIXED_NOW - 1_000
    );
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '1001',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toBeNull();
    await expectSourcePayloadIntact(stub, seeded, 'fixed-plan-row-over-pass');
  });

  it('archives only approved manifest rows and fails closed if an approved source changes', async () => {
    const projectId = `${TEST_PREFIX}-manifest-binding`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const approved = await seedToolMessages(stub, [
      { id: 'approved-row', createdAt: FIXED_NOW - 3_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manifest-binding-plan',
      FIXED_NOW - 1_000
    );
    const addedLater = await seedToolMessages(stub, [
      { id: 'backfilled-after-approval', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
      },
      {
        now: FIXED_NOW,
        nowMs: () => FIXED_NOW,
      }
    );
    expect(result?.rowsUpdated).toBe(1);
    const after = await readMessageContentAndMetadata(stub, [
      approved.messageIds[0]!,
      addedLater.messageIds[0]!,
    ]);
    expect(after.get(approved.messageIds[0]!)?.content).toBe('visible approved-row');
    expect(after.get(approved.messageIds[0]!)?.toolMetadata.content).toBeUndefined();
    expect(Array.isArray(after.get(addedLater.messageIds[0]!)?.toolMetadata.content)).toBe(true);

    const changedProjectId = `${TEST_PREFIX}-manifest-source-change`;
    const changedStub = getStub(changedProjectId);
    await changedStub.ensureProjectId(changedProjectId);
    const changed = await seedToolMessages(changedStub, [
      { id: 'changed-approved-row', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const changedApproval = await approvedCleanupEnv(
      changedProjectId,
      'manifest-source-change-plan',
      FIXED_NOW - 1_000
    );
    await runInDurableObject(changedStub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeToolMetadata('changed-after-approval', 2_048),
        changed.messageIds[0]
      );
    });
    const changedResult = await runArchiveCleanup(changedStub, changedProjectId, changedApproval, {
      now: FIXED_NOW,
      nowMs: () => FIXED_NOW,
    });
    expect(changedResult).toMatchObject({ rowsUpdated: 0, rowsFailed: 1 });
    const changedSource = (
      await readMessageContentAndMetadata(changedStub, changed.messageIds)
    ).get(changed.messageIds[0]!);
    expect(changedSource?.content).toBe('visible changed-approved-row');
    expect(JSON.stringify(changedSource?.toolMetadata.content)).toContain('changed-after-approval');
    expect(await readArchiveRows(changedStub, changed.messageIds)).toHaveLength(0);
  });

  it('charges verified idempotent resume reads to the cumulative R2 operation ceiling', async () => {
    const projectId = `${TEST_PREFIX}-manifest-resume-r2-budget`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manifest-resume-r2-budget', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manifest-resume-r2-budget-plan',
      FIXED_NOW - 1_000
    );
    expect(
      await runArchiveCleanup(stub, projectId, approval, {
        now: FIXED_NOW,
        nowMs: () => FIXED_NOW,
      })
    ).toMatchObject({ rowsUpdated: 1, rowsFailed: 0 });

    const clearPlanState = async (): Promise<void> => {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DELETE FROM do_meta WHERE key LIKE 'storageSafetyTool%'");
      });
    };
    await clearPlanState();
    const boundedFailure = await runArchiveCleanup(
      stub,
      projectId,
      { ...approval, PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS: '5' },
      { now: FIXED_NOW + 1, nowMs: () => FIXED_NOW + 1 }
    );
    expect(boundedFailure).toMatchObject({ rowsUpdated: 0, rowsFailed: 1 });
    const failedOperations = await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql
        .exec("SELECT value FROM do_meta WHERE key = 'storageSafetyToolCleanupTotalR2Operations'")
        .one() as { value: string };
      return Number(row.value);
    });
    expect(failedOperations).toBe(5);

    await clearPlanState();
    const boundedSuccess = await runArchiveCleanup(
      stub,
      projectId,
      { ...approval, PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS: '6' },
      { now: FIXED_NOW + 2, nowMs: () => FIXED_NOW + 2 }
    );
    expect(boundedSuccess).toMatchObject({ rowsUpdated: 0, rowsFailed: 0 });
    await expectSourcePayloadArchived(stub, seeded, 'manifest-resume-r2-budget');
  });

  it('resumes an exact manifest across passes without rescanning or double counting', async () => {
    const projectId = `${TEST_PREFIX}-manifest-exact-continuation`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manifest-exact-first', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'manifest-exact-second', createdAt: FIXED_NOW - 2_000, sequence: 2 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manifest-exact-continuation-plan',
      FIXED_NOW - 1_000
    );
    const exactEnv = {
      ...approval,
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '1',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '1',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS: String(
        Number(approval.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS) + 1
      ),
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES: String(
        Number(approval.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES) + 1
      ),
    };
    const readProgress = async (): Promise<Record<string, number>> =>
      runInDurableObject(stub, async (_instance, state) => {
        const rows = state.storage.sql
          .exec(
            `SELECT key, value FROM do_meta
             WHERE key IN (
               'storageSafetyToolCleanupTotalRows',
               'storageSafetyToolCleanupTotalBytes',
               'storageSafetyToolCleanupTotalR2Operations',
               'storageSafetyToolCleanupTotalWallTimeMs'
             )`
          )
          .toArray() as Array<{ key: string; value: string }>;
        return Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]));
      });

    const first = await runArchiveCleanup(stub, projectId, exactEnv, {
      now: FIXED_NOW,
      nowMs: () => FIXED_NOW,
    });
    expect(first).toMatchObject({ rowsScanned: 1, rowsUpdated: 1, rowsFailed: 0 });
    expect(first?.cursor?.messageId).toBe(seeded.messageIds[0]);
    expect(await readProgress()).toMatchObject({
      storageSafetyToolCleanupTotalRows: 1,
      storageSafetyToolCleanupTotalR2Operations: 1500,
      storageSafetyToolCleanupTotalWallTimeMs: 20000,
    });

    const second = await runArchiveCleanup(stub, projectId, exactEnv, {
      now: FIXED_NOW + 2,
      nowMs: () => FIXED_NOW + 2,
    });
    expect(second).toMatchObject({ rowsScanned: 1, rowsUpdated: 1, rowsFailed: 0 });
    expect(second?.cursor).toBeNull();
    expect(await readProgress()).toEqual({
      storageSafetyToolCleanupTotalRows: 2,
      storageSafetyToolCleanupTotalBytes: Number(
        approval.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES
      ),
      storageSafetyToolCleanupTotalR2Operations: 3000,
      storageSafetyToolCleanupTotalWallTimeMs: 40000,
    });
    let replayReads = 0;
    let replayWrites = 0;
    const realR2 = env.PROJECT_DATA_ARCHIVE_R2;
    const replayTrackingR2 = {
      put: async (key: string, value: string | ArrayBuffer | ArrayBufferView) => {
        replayWrites += 1;
        return realR2.put(key, value);
      },
      get: async (key: string) => {
        replayReads += 1;
        return realR2.get(key);
      },
    } as unknown as R2Bucket;
    const sourcesBeforeReplay = await readMessageContentAndMetadata(stub, seeded.messageIds);
    const archivesBeforeReplay = await readArchiveRows(stub, seeded.messageIds);
    expect(
      await runArchiveCleanup(
        stub,
        projectId,
        { ...exactEnv, PROJECT_DATA_ARCHIVE_R2: replayTrackingR2 },
        {
          now: FIXED_NOW + 4,
          nowMs: () => FIXED_NOW + 4,
        }
      )
    ).toBeNull();
    expect(replayReads).toBe(0);
    expect(replayWrites).toBe(0);
    expect(await readMessageContentAndMetadata(stub, seeded.messageIds)).toEqual(
      sourcesBeforeReplay
    );
    expect(await readArchiveRows(stub, seeded.messageIds)).toEqual(archivesBeforeReplay);
    const terminalState = await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec(
          `SELECT key, value FROM do_meta
           WHERE key IN (
             'storageSafetyToolCleanupPlanTerminal',
             'storageSafetyToolCleanupRecheckAt'
           )`
        )
        .toArray() as Array<{ key: string; value: string }>;
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    });
    expect(terminalState).toEqual({ storageSafetyToolCleanupPlanTerminal: 'true' });
    const sources = await readMessageContentAndMetadata(stub, seeded.messageIds);
    expect(sources.get(seeded.messageIds[0]!)?.content).toBe('visible manifest-exact-first');
    expect(sources.get(seeded.messageIds[1]!)?.content).toBe('visible manifest-exact-second');
    expect(sources.get(seeded.messageIds[0]!)?.toolMetadata.content).toBeUndefined();
    expect(sources.get(seeded.messageIds[1]!)?.toolMetadata.content).toBeUndefined();
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(2);
  });

  it('fails closed on equal-length approved root-manifest corruption', async () => {
    const projectId = `${TEST_PREFIX}-manifest-root-corruption`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manifest-root-corruption', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manifest-root-corruption-plan',
      FIXED_NOW - 1_000
    );
    const rootKey = approval.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY;
    const rootObject = await env.PROJECT_DATA_ARCHIVE_R2.get(rootKey);
    expect(rootObject).not.toBeNull();
    const corrupted = new Uint8Array(await rootObject!.arrayBuffer());
    corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 1;
    await env.PROJECT_DATA_ARCHIVE_R2.put(rootKey, corrupted);

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
      },
      {
        now: FIXED_NOW,
        nowMs: () => FIXED_NOW,
      }
    );
    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1 });
    await expectSourcePayloadIntact(stub, seeded, 'manifest-root-corruption');
  });

  it('refuses an approved manifest whose totals exceed the cumulative operator ceilings', async () => {
    const projectId = `${TEST_PREFIX}-manifest-total-ceiling`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'manifest-total-ceiling', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const approval = await approvedCleanupEnv(
      projectId,
      'manifest-total-ceiling-plan',
      FIXED_NOW - 1_000
    );
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        ...approval,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES: String(
          Number(approval.PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES) - 1
        ),
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1 });
    await expectSourcePayloadIntact(stub, seeded, 'manifest-total-ceiling');
  });

  it('fails closed when cleanup budgets drift across a fixed-plan continuation', async () => {
    const projectId = `${TEST_PREFIX}-fixed-plan-drift`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-plan-first', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'fixed-plan-second', createdAt: FIXED_NOW - 2_000, sequence: 2 },
    ]);
    const base = {
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
      ...(await approvedCleanupEnv(projectId, 'fixed-plan-drift-test', FIXED_NOW - 1_000)),
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: '0.00002',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: '0.00001',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '1',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '1',
    };

    const first = await runArchiveCleanup(stub, projectId, base, {
      now: FIXED_NOW,
      nowMs: () => FIXED_NOW,
    });
    expect(first).toMatchObject({ rowsUpdated: 1, cursor: expect.any(Object) });

    const drifted = await runArchiveCleanup(
      stub,
      projectId,
      { ...base, PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '3000000' },
      { now: FIXED_NOW + 2, nowMs: () => FIXED_NOW + 2 }
    );
    expect(drifted).toBeNull();
    const state = await readMessageContentAndMetadata(stub, seeded.messageIds);
    expect(state.get(seeded.messageIds[0]!)?.content).toBe('visible fixed-plan-first');
    expect(state.get(seeded.messageIds[0]!)?.toolMetadata.content).toBeUndefined();
    expect(Array.isArray(state.get(seeded.messageIds[1]!)?.toolMetadata.content)).toBe(true);
  });

  it('fails closed rather than defaulting a malformed fixed-plan budget', async () => {
    const projectId = `${TEST_PREFIX}-fixed-plan-malformed-budget`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fixed-plan-malformed-budget', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID: 'fixed-plan-malformed-budget',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: projectId,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: String(FIXED_NOW - 1_000),
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS: '3garbage',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toBeNull();
    expect(
      Array.isArray(
        (await readMessageMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)?.content
      )
    ).toBe(true);
  });

  it('fails closed when the configured fixed creation cutoff is invalid', async () => {
    const projectId = `${TEST_PREFIX}-invalid-fixed-cutoff`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'invalid-fixed-cutoff', createdAt: FIXED_NOW - 2_000, sequence: 1 },
    ]);

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: 'not-a-timestamp',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result).toBeNull();
    expect(
      Array.isArray(
        (await readMessageMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)?.content
      )
    ).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('fails closed when a successful R2 put cannot be read back for verification', async () => {
    const projectId = `${TEST_PREFIX}-r2-readback-missing`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'r2-readback-missing', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const missingReadbackR2 = {
      put: async () => null,
      get: async () => null,
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_ARCHIVE_R2: missingReadbackR2,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    expect(result?.terminationReason).toBe('error');
    const row = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(row?.content).toBe('visible r2-readback-missing');
    expect(Array.isArray(row?.toolMetadata.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('fails closed when R2 readback bytes differ from the written archive', async () => {
    const projectId = `${TEST_PREFIX}-r2-readback-corrupt`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'r2-readback-corrupt', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const corruptReadbackR2 = {
      put: async () => null,
      get: async () =>
        ({
          arrayBuffer: async () => new TextEncoder().encode('{"corrupt":true}').buffer,
        }) as R2ObjectBody,
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_ARCHIVE_R2: corruptReadbackR2,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    expect(result?.terminationReason).toBe('error');
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('fails closed on equal-length R2 readback corruption via SHA-256 verification', async () => {
    const projectId = `${TEST_PREFIX}-r2-readback-sha-corrupt`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'r2-readback-sha-corrupt', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const objects = new Map<string, Uint8Array>();
    const corruptReadbackR2 = {
      put: async (key: string, value: string | Uint8Array) => {
        objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
        return null;
      },
      get: async (key: string) => {
        const stored = objects.get(key);
        if (!stored) return null;
        const corrupted = stored.slice();
        corrupted[0] = (corrupted[0] ?? 0) ^ 1;
        return { arrayBuffer: async () => corrupted.buffer } as R2ObjectBody;
      },
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_ARCHIVE_R2: corruptReadbackR2,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1, terminationReason: 'error' });
    await expectSourcePayloadIntact(stub, seeded, 'r2-readback-sha-corrupt');
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toEqual([
      expect.objectContaining({ message_id: seeded.messageIds[0], status: 'retryable_failure' }),
    ]);
  });

  it('fails closed when local archive bookkeeping fails after the R2 write', async () => {
    const projectId = `${TEST_PREFIX}-local-atomicity`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'local-failure', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_tool_payload_metadata_update
        BEFORE UPDATE OF tool_metadata ON chat_messages
        BEGIN
          SELECT RAISE(ABORT, 'forced tool_metadata update failure');
        END
      `);
    });

    const result = await runArchiveCleanup(
      stub,
      projectId,
      { PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0' },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('does not overwrite tool metadata that changes while R2 verification is in flight', async () => {
    const projectId = `${TEST_PREFIX}-source-cas-race`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'source-cas-race', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const changedMetadata = makeToolMetadata('changed-during-r2', 256);
    const result = await withRuntimeEnv(
      { PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0' },
      async () =>
        runInDurableObject(stub, async (_instance, state) => {
          const objects = new Map<string, Uint8Array>();
          let changed = false;
          const bucket = {
            put: async (key: string, value: string | Uint8Array) => {
              objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
              return null;
            },
            get: async (key: string) => {
              if (!changed) {
                changed = true;
                state.storage.sql.exec(
                  'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
                  changedMetadata,
                  seeded.messageIds[0]
                );
              }
              const stored = objects.get(key);
              return stored ? ({ arrayBuffer: async () => stored.buffer } as R2ObjectBody) : null;
            },
          } as unknown as R2Bucket;
          const previous = testEnv.PROJECT_DATA_ARCHIVE_R2;
          testEnv.PROJECT_DATA_ARCHIVE_R2 = bucket;
          try {
            const config = resolveStorageSafetyConfig(testEnv);
            return await runProjectDataToolPayloadCleanup(
              state.storage.sql,
              testEnv,
              projectId,
              config,
              {
                allowStart: true,
                now: FIXED_NOW,
                nowMs: () => FIXED_NOW,
                transactionSync: (callback) => state.storage.transactionSync(callback),
                classifyStatus: (databaseSizeBytes) =>
                  classifyStorageUsage(databaseSizeBytes, config),
                recordTelemetry: async () => undefined,
              }
            );
          } finally {
            testEnv.PROJECT_DATA_ARCHIVE_R2 = previous;
          }
        })
    );

    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1, terminationReason: 'error' });
    const source = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(source?.content).toBe('visible source-cas-race');
    expect(source?.toolMetadata).toEqual(JSON.parse(changedMetadata));
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('bounds a slow R2 archive write with a configurable timeout', async () => {
    const projectId = `${TEST_PREFIX}-archive-timeout`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'slow-r2', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    const slowR2 = {
      put: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS: '1',
        PROJECT_DATA_ARCHIVE_R2: slowR2,
      },
      { now: FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('preserves a deferred retry after later candidates are archived', async () => {
    const projectId = `${TEST_PREFIX}-retry-carry-forward`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'retry-first', createdAt: FIXED_NOW - 2_000, sequence: 1 },
      { id: 'archive-second', createdAt: FIXED_NOW - 1_000, sequence: 2 },
    ]);
    const failingMessageId = seeded.messageIds[0]!;
    const backingR2 = env.PROJECT_DATA_ARCHIVE_R2;
    const failingR2 = {
      put: async (key: string, value: string | Uint8Array, options?: R2PutOptions) => {
        if (key.includes(encodeURIComponent(failingMessageId))) {
          throw new Error('forced retryable archive failure');
        }
        return backingR2.put(key, value, options);
      },
      get: async (key: string) => backingR2.get(key),
    } as unknown as R2Bucket;

    const first = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS: '300000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
        PROJECT_DATA_ARCHIVE_R2: failingR2,
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(first?.rowsUpdated).toBe(0);
    expect(first?.rowsFailed).toBe(1);

    const second = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS: '300000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '60000',
        PROJECT_DATA_ARCHIVE_R2: failingR2,
      },
      { now: FIXED_NOW + 60_001, nowMs: () => FIXED_NOW + 60_001 }
    );
    expect(second?.rowsUpdated).toBe(1);
    expect(second?.rowsFailed).toBe(0);
    expect(second?.exhaustedCandidates).toBe(false);
    expect(second?.recheckAt).toBe(FIXED_NOW + 300_000);

    const metadataAfterSecond = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadataAfterSecond.get(failingMessageId)?.content)).toBe(true);
    expect(metadataAfterSecond.get(seeded.messageIds[1]!)?.content).toBeUndefined();
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toEqual([
      expect.objectContaining({
        message_id: failingMessageId,
        status: 'retryable_failure',
        failure_count: 1,
      }),
    ]);

    const third = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS: '300000',
      },
      { now: FIXED_NOW + 300_001, nowMs: () => FIXED_NOW + 300_001 }
    );
    expect(third?.rowsUpdated).toBe(1);
    expect(third?.rowsFailed).toBe(0);
    const metadataAfterThird = await readMessageMetadata(stub, seeded.messageIds);
    expect(metadataAfterThird.get(failingMessageId)?.content).toBeUndefined();
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toHaveLength(0);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(2);
  });

  it('archives and retrieves a legacy payload above the former 1MiB row budget with R2 chunks', async () => {
    const projectId = `${TEST_PREFIX}-chunked-oversized`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'chunked-large', createdAt: FIXED_NOW - 1_000, sequence: 1, payloadBytes: 1_150_000 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeToolMetadata('chunked-large', 1_150_000),
        seeded.messageIds[0]
      );
    });

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1800000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '1800000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '200000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES: '1800000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(1);
    expect(result?.terminationReason).toBe('target_reached');
    const archiveRows = await readArchiveRows(stub, seeded.messageIds);
    expect(archiveRows).toHaveLength(1);
    expect(archiveRows[0]?.archive_version).toBe(3);
    expect(archiveRows[0]).toMatchObject({
      archive_body_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      root_object_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verified_object_count: expect.any(Number),
    });
    expect(
      (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)
        ?.content
    ).toBe('visible chunked-large');

    const manifest = await env.PROJECT_DATA_ARCHIVE_R2.get(archiveRows[0]!.r2_key);
    const manifestJson = JSON.parse((await manifest?.text()) ?? '{}') as {
      chunks?: Array<{ key: string }>;
    };
    expect(manifestJson.chunks?.length).toBeGreaterThan(1);
    const firstChunk = await env.PROJECT_DATA_ARCHIVE_R2.get(manifestJson.chunks![0]!.key);
    expect(firstChunk).not.toBeNull();

    const loaded = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(loaded?.source).toBe('archive');
    expect(JSON.stringify(loaded?.content)).toContain('chunked-large');

    const originalChunk = new Uint8Array(await firstChunk!.arrayBuffer());
    const corruptedChunk = originalChunk.slice();
    corruptedChunk[0] = (corruptedChunk[0] ?? 0) ^ 1;
    await env.PROJECT_DATA_ARCHIVE_R2.put(manifestJson.chunks![0]!.key, corruptedChunk);
    const corrupt = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(corrupt?.source).toBe('archived_unavailable');
    expect(corrupt?.archived.reason).toContain('archived R2 chunk SHA-256 verification failed');
    await env.PROJECT_DATA_ARCHIVE_R2.put(manifestJson.chunks![0]!.key, originalChunk);

    await env.PROJECT_DATA_ARCHIVE_R2.delete(manifestJson.chunks![0]!.key);
    const unavailable = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(unavailable?.source).toBe('archived_unavailable');
    expect(unavailable?.archived.reason).toContain('archived R2 chunk is missing');
  });

  it('reconsiders stale oversized cleanup attempts that now fit the archive cap', async () => {
    const projectId = `${TEST_PREFIX}-stale-oversized-retry`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'stale-oversized', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeToolMetadata('stale-oversized', 1_100_000),
        seeded.messageIds[0]
      );
    });

    const first = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1400000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES: '1000000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(first?.rowsFailed).toBe(1);
    expect(first?.terminationReason).toBe('oversized_skip');
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toEqual([
      expect.objectContaining({ message_id: seeded.messageIds[0], status: 'oversized' }),
    ]);

    const second = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1600000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '1900000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '200000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES: '1900000',
      },
      { now: FIXED_NOW + 2, nowMs: () => FIXED_NOW + 2 }
    );

    expect(second?.rearchivableOversizedAttemptsReset).toBe(1);
    expect(second?.rowsUpdated).toBe(1);
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toHaveLength(0);
    const archiveRows = await readArchiveRows(stub, seeded.messageIds);
    expect(archiveRows).toHaveLength(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(metadata.get(seeded.messageIds[0]!)?.content).toBeUndefined();
  });

  it('leaves source metadata intact when a chunked R2 archive write fails', async () => {
    const projectId = `${TEST_PREFIX}-chunk-write-failure`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'chunk-failure', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeToolMetadata('chunk-failure', 1_150_000),
        seeded.messageIds[0]
      );
    });

    const backingR2 = env.PROJECT_DATA_ARCHIVE_R2;
    const failingBucket = {
      put: async (key: string, value: string | Uint8Array, options?: R2PutOptions) => {
        if (key.includes('.chunk-1.')) throw new Error('simulated chunk write failure');
        return backingR2.put(key, value, options);
      },
      get: async (key: string) => backingR2.get(key),
    } as unknown as R2Bucket;
    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_ARCHIVE_R2: failingBucket,
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1800000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '1800000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '200000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES: '1800000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    expect(result?.terminationReason).toBe('error');
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toEqual([
      expect.objectContaining({
        message_id: seeded.messageIds[0],
        status: 'retryable_failure',
      }),
    ]);
  });

  it('leaves source text and metadata intact when a written chunk is missing on verification', async () => {
    const projectId = `${TEST_PREFIX}-chunk-readback-missing`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      {
        id: 'chunk-readback-missing',
        createdAt: FIXED_NOW - 1_000,
        sequence: 1,
        payloadBytes: 8_000,
      },
    ]);
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, value: string | Uint8Array) => {
        objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value);
        return null;
      },
      get: async (key: string) => {
        if (key.includes('.chunk-0.')) return null;
        const stored = objects.get(key);
        return stored ? ({ arrayBuffer: async () => stored.buffer } as R2ObjectBody) : null;
      },
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_ARCHIVE_R2: bucket,
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '1000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1, terminationReason: 'error' });
    await expectSourcePayloadIntact(stub, seeded, 'chunk-readback-missing');
  });

  it('leaves source text and metadata intact on equal-length chunk readback corruption', async () => {
    const projectId = `${TEST_PREFIX}-chunk-readback-corrupt`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      {
        id: 'chunk-readback-corrupt',
        createdAt: FIXED_NOW - 1_000,
        sequence: 1,
        payloadBytes: 8_000,
      },
    ]);
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      put: async (key: string, value: string | Uint8Array) => {
        objects.set(
          key,
          typeof value === 'string' ? new TextEncoder().encode(value) : value.slice()
        );
        return null;
      },
      get: async (key: string) => {
        const stored = objects.get(key);
        if (!stored) return null;
        const returned = stored.slice();
        if (key.includes('.chunk-0.')) returned[0] = (returned[0] ?? 0) ^ 1;
        return { arrayBuffer: async () => returned.buffer } as R2ObjectBody;
      },
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_ARCHIVE_R2: bucket,
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '1000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1, terminationReason: 'error' });
    await expectSourcePayloadIntact(stub, seeded, 'chunk-readback-corrupt');
  });

  it('fails before writing when a chunked archive exceeds the R2 operation budget', async () => {
    const projectId = `${TEST_PREFIX}-r2-operation-budget`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'r2-operation-budget', createdAt: FIXED_NOW - 1_000, sequence: 1, payloadBytes: 8_000 },
    ]);
    let puts = 0;
    const bucket = {
      put: async () => {
        puts++;
        return null;
      },
      get: async () => null,
    } as unknown as R2Bucket;

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_ARCHIVE_R2: bucket,
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '1000',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS: '3',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(result).toMatchObject({ rowsUpdated: 0, rowsFailed: 1, terminationReason: 'error' });
    expect(puts).toBe(0);
    expect(
      Array.isArray(
        (await readMessageMetadata(stub, seeded.messageIds)).get(seeded.messageIds[0]!)?.content
      )
    ).toBe(true);
  });

  it('archives only tool payloads strictly older than the retention boundary', async () => {
    const projectId = `${TEST_PREFIX}-boundary`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const cutoff = FIXED_NOW - 7 * DAY_MS;
    const seeded = await seedToolMessages(stub, [
      { id: 'old', createdAt: cutoff - 1, sequence: 1 },
      { id: 'boundary', createdAt: cutoff, sequence: 2 },
      { id: 'recent', createdAt: cutoff + 1, sequence: 3 },
    ]);

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '7',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
      },
      { now: FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(metadata.get(seeded.messageIds[0]!)?.content).toBeUndefined();
    expect(metadata.get(seeded.messageIds[0]!)?.toolPayloadArchive).toMatchObject({
      status: 'archived',
      archivedAt: FIXED_NOW,
      version: 1,
    });
    expect(Array.isArray(metadata.get(seeded.messageIds[1]!)?.content)).toBe(true);
    expect(Array.isArray(metadata.get(seeded.messageIds[2]!)?.content)).toBe(true);

    const archiveRows = await readArchiveRows(stub, seeded.messageIds);
    expect(archiveRows).toHaveLength(1);
    expect(archiveRows[0]).toMatchObject({
      archive_version: 3,
      archive_body_bytes: expect.any(Number),
      archive_body_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      root_object_bytes: expect.any(Number),
      root_object_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      verified_object_count: 1,
    });
    expect(archiveRows[0]!.r2_key).toMatch(/\.[a-f0-9]{64}\.json$/);
    const preserved = (await readMessageContentAndMetadata(stub, seeded.messageIds)).get(
      seeded.messageIds[0]!
    );
    expect(preserved?.content).toBe('visible old');
    const object = await env.PROJECT_DATA_ARCHIVE_R2.get(archiveRows[0]!.r2_key);
    expect(object).not.toBeNull();
    const archived = JSON.parse((await object?.text()) ?? '{}') as Record<string, unknown>;
    expect(archived.messageId).toBe(seeded.messageIds[0]);
    expect((archived.toolMetadata as Record<string, unknown>).content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text' })])
    );
  });

  it('never archives recent or non-tool payload metadata controls', async () => {
    const projectId = `${TEST_PREFIX}-ineligible-control`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const cutoff = FIXED_NOW - 7 * DAY_MS;
    const messageIds = await runInDurableObject(stub, async (instance, state) => {
      const sessionId = await instance.createSession(null, 'Ineligible archive controls');
      const oldAssistant = await instance.persistMessage(
        sessionId,
        'assistant',
        'assistant visible text must remain',
        makeToolMetadata('old-assistant'),
        'assistant-tool-like'
      );
      const recentTool = await instance.persistMessage(
        sessionId,
        'tool',
        'recent visible text must remain',
        makeToolMetadata('recent-tool'),
        'recent-tool'
      );
      state.storage.sql.exec(
        'UPDATE chat_messages SET created_at = ?, sequence = ? WHERE id = ?',
        cutoff - 1,
        1,
        oldAssistant
      );
      state.storage.sql.exec(
        'UPDATE chat_messages SET created_at = ?, sequence = ? WHERE id = ?',
        cutoff + 1,
        2,
        recentTool
      );
      return [oldAssistant, recentTool];
    });

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '7',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
      },
      { now: FIXED_NOW }
    );

    expect(result).toBeNull();
    const metadata = await readMessageMetadata(stub, messageIds);
    expect(Array.isArray(metadata.get(messageIds[0]!)?.content)).toBe(true);
    expect(Array.isArray(metadata.get(messageIds[1]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, messageIds)).toHaveLength(0);
  });

  it('does not spend cleanup batch capacity on tool metadata without payload content', async () => {
    const projectId = `${TEST_PREFIX}-payload-discriminator`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const cutoff = FIXED_NOW - 7 * DAY_MS;
    const seeded = await seedToolMessages(stub, [
      { id: 'metadata-only', createdAt: cutoff - 2_000, sequence: 1 },
      { id: 'reclaimable', createdAt: cutoff - 1_000, sequence: 2 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        makeToolMetadataWithoutContent('metadata-only'),
        seeded.messageIds[0]
      );
    });

    const result = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '7',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
      },
      { now: FIXED_NOW }
    );

    expect(result?.rowsScanned).toBe(1);
    expect(result?.rowsUpdated).toBe(1);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(metadata.get(seeded.messageIds[0]!)?.summary).toBe('metadata only metadata-only');
    expect(metadata.get(seeded.messageIds[0]!)?.content).toBeUndefined();
    expect(metadata.get(seeded.messageIds[1]!)?.content).toBeUndefined();
    expect(metadata.get(seeded.messageIds[1]!)?.toolPayloadArchive).toMatchObject({
      status: 'archived',
      archivedAt: FIXED_NOW,
      version: 1,
    });
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(1);
    expect(await readCleanupAttempts(stub, seeded.messageIds)).toHaveLength(0);
  });

  it('enforces row, byte, and wall-time budgets with continuation rechecks', async () => {
    const rowBudgetProjectId = `${TEST_PREFIX}-row-budget`;
    const rowBudgetStub = getStub(rowBudgetProjectId);
    await rowBudgetStub.ensureProjectId(rowBudgetProjectId);
    const rowBudgetSeeded = await seedToolMessages(rowBudgetStub, [
      { id: 'row-1', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'row-2', createdAt: FIXED_NOW - 2_000, sequence: 2 },
    ]);
    const rowBudgetResult = await runArchiveCleanup(
      rowBudgetStub,
      rowBudgetProjectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
      },
      { now: FIXED_NOW }
    );
    expect(rowBudgetResult?.rowsScanned).toBe(1);
    expect(rowBudgetResult?.recheckAt).toBe(
      FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    );
    const rowMetadata = await readMessageMetadata(rowBudgetStub, rowBudgetSeeded.messageIds);
    expect(rowMetadata.get(rowBudgetSeeded.messageIds[0]!)?.content).toBeUndefined();
    expect(Array.isArray(rowMetadata.get(rowBudgetSeeded.messageIds[1]!)?.content)).toBe(true);

    const byteBudgetProjectId = `${TEST_PREFIX}-byte-budget`;
    const byteBudgetStub = getStub(byteBudgetProjectId);
    await byteBudgetStub.ensureProjectId(byteBudgetProjectId);
    const byteBudgetSeeded = await seedToolMessages(byteBudgetStub, [
      { id: 'byte-1', createdAt: FIXED_NOW - 3_000, sequence: 1, payloadBytes: 64 * 1024 },
      { id: 'byte-2', createdAt: FIXED_NOW - 2_000, sequence: 2, payloadBytes: 64 * 1024 },
    ]);
    const byteBudgetResult = await runArchiveCleanup(
      byteBudgetStub,
      byteBudgetProjectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '70000',
      },
      { now: FIXED_NOW }
    );
    expect(byteBudgetResult?.rowsScanned).toBe(1);
    expect(byteBudgetResult?.recheckAt).toBe(
      FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    );
    const byteMetadata = await readMessageMetadata(byteBudgetStub, byteBudgetSeeded.messageIds);
    expect(byteMetadata.get(byteBudgetSeeded.messageIds[0]!)?.content).toBeUndefined();
    expect(Array.isArray(byteMetadata.get(byteBudgetSeeded.messageIds[1]!)?.content)).toBe(true);

    const wallBudgetProjectId = `${TEST_PREFIX}-wall-budget`;
    const wallBudgetStub = getStub(wallBudgetProjectId);
    await wallBudgetStub.ensureProjectId(wallBudgetProjectId);
    const wallBudgetSeeded = await seedToolMessages(wallBudgetStub, [
      { id: 'wall-1', createdAt: FIXED_NOW - 3_000, sequence: 1 },
      { id: 'wall-2', createdAt: FIXED_NOW - 2_000, sequence: 2 },
    ]);
    let clockCalls = 0;
    const wallBudgetResult = await runArchiveCleanup(
      wallBudgetStub,
      wallBudgetProjectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS: '1',
      },
      {
        now: FIXED_NOW,
        nowMs: () => (clockCalls++ === 0 ? FIXED_NOW : FIXED_NOW + 2),
      }
    );
    expect(wallBudgetResult?.rowsScanned).toBe(1);
    expect(wallBudgetResult).toMatchObject({
      rowsUpdated: 0,
      rowsFailed: 1,
      terminationReason: 'error',
    });
    expect(wallBudgetResult?.recheckAt).toBe(
      FIXED_NOW + DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    );
    const wallMetadata = await readMessageMetadata(wallBudgetStub, wallBudgetSeeded.messageIds);
    expect(Array.isArray(wallMetadata.get(wallBudgetSeeded.messageIds[0]!)?.content)).toBe(true);
    expect(Array.isArray(wallMetadata.get(wallBudgetSeeded.messageIds[1]!)?.content)).toBe(true);
  });

  it('lets a non-reclaimable candidate escape across complete cleanup sweeps', async () => {
    const projectId = `${TEST_PREFIX}-candidate-escape`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'poison', createdAt: FIXED_NOW - 2_000, sequence: 1 },
      { id: 'valid-after-poison', createdAt: FIXED_NOW - 1_000, sequence: 2 },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
        JSON.stringify([{ content: [{ type: 'text', text: 'poison' }] }]),
        seeded.messageIds[0]
      );
    });

    const first = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
      },
      { now: FIXED_NOW, nowMs: () => FIXED_NOW }
    );
    expect(first?.rowsFailed).toBe(1);
    expect(first?.rowsUpdated).toBe(1);

    const attemptsAfterFirst = await readCleanupAttempts(stub, seeded.messageIds);
    expect(attemptsAfterFirst).toEqual([
      expect.objectContaining({
        message_id: seeded.messageIds[0],
        status: 'invalid_metadata',
        failure_count: 1,
      }),
    ]);

    const second = await runArchiveCleanup(
      stub,
      projectId,
      {
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0',
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '1',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_ROWS: '10',
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_BATCH_BYTES: '1000000',
      },
      { now: FIXED_NOW + 2, nowMs: () => FIXED_NOW + 2 }
    );
    expect(second?.rowsFailed ?? 0).toBe(0);
    expect(second?.rowsUpdated ?? 0).toBe(0);

    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    const poisonMetadata = metadata.get(seeded.messageIds[0]!) as unknown;
    expect(Array.isArray(poisonMetadata)).toBe(true);
    expect(Array.isArray((poisonMetadata as Array<Record<string, unknown>>)[0]?.content)).toBe(
      true
    );
    expect(metadata.get(seeded.messageIds[1]!)?.content).toBeUndefined();
    const attemptsAfterSecond = await readCleanupAttempts(stub, seeded.messageIds);
    expect(attemptsAfterSecond).toEqual(attemptsAfterFirst);
  });

  it('lazy-loads archived content from R2 and degrades explicitly when the object is missing', async () => {
    const projectId = `${TEST_PREFIX}-fallback`;
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'fallback', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);

    await runArchiveCleanup(
      stub,
      projectId,
      { PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0' },
      { now: FIXED_NOW }
    );

    const loaded = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(loaded?.source).toBe('archive');
    expect(loaded?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text' })])
    );

    const archiveRows = await readArchiveRows(stub, seeded.messageIds);
    const root = await env.PROJECT_DATA_ARCHIVE_R2.get(archiveRows[0]!.r2_key);
    const originalRoot = new Uint8Array(await root!.arrayBuffer());
    const corruptRoot = originalRoot.slice();
    corruptRoot[0] = (corruptRoot[0] ?? 0) ^ 1;
    await env.PROJECT_DATA_ARCHIVE_R2.put(archiveRows[0]!.r2_key, corruptRoot);
    const corrupt = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(corrupt?.source).toBe('archived_unavailable');
    expect(corrupt?.archived.reason).toContain('root SHA-256 verification failed');
    await env.PROJECT_DATA_ARCHIVE_R2.put(archiveRows[0]!.r2_key, originalRoot);
    expect(
      (await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!))?.source
    ).toBe('archive');
    await env.PROJECT_DATA_ARCHIVE_R2.delete(archiveRows[0]!.r2_key);
    const unavailable = await stub.getMessageToolContent(seeded.sessionId, seeded.messageIds[0]!);
    expect(unavailable?.source).toBe('archived_unavailable');
    expect((unavailable?.content[0] as { text?: string }).text).toContain(
      'temporarily unavailable'
    );
  });

  it('retrieves archived tool payloads through the MCP tool', async () => {
    const projectId = `${TEST_PREFIX}-mcp`;
    const { userId } = await seedProjectGraph(projectId);
    const stub = getStub(projectId);
    await stub.ensureProjectId(projectId);
    const seeded = await seedToolMessages(stub, [
      { id: 'mcp', createdAt: FIXED_NOW - 1_000, sequence: 1 },
    ]);
    await runArchiveCleanup(
      stub,
      projectId,
      { PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '0' },
      { now: FIXED_NOW }
    );
    const token = `${projectId}-token`;
    await storeMcpToken(env.KV, token, {
      taskId: `${projectId}-task`,
      projectId,
      userId,
      workspaceId: `${projectId}-workspace`,
      // Authentication lifetime is evaluated against the real Worker clock;
      // FIXED_NOW belongs only to the archive-retention scenario and eventually
      // ages beyond the MCP token's hard maximum lifetime.
      createdAt: new Date().toISOString(),
    });

    const response = await callMcpTool(token, 'get_archived_tool_payloads', {
      messageId: seeded.messageIds[0],
    });

    expect(response.error).toBeUndefined();
    const text = response.result?.content?.[0]?.text ?? '{}';
    const result = JSON.parse(text) as {
      payloads: Array<{ messageId: string; available: boolean; content: unknown[] }>;
    };
    expect(result.payloads).toHaveLength(1);
    expect(result.payloads[0]?.messageId).toBe(seeded.messageIds[0]);
    expect(result.payloads[0]?.available).toBe(true);
    expect(result.payloads[0]?.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text' })])
    );
  });
});
