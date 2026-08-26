import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  classifyStorageUsage,
  resolveStorageSafetyConfig,
} from '../../src/durable-objects/project-data/storage-safety';
import { runProjectDataToolPayloadCleanup } from '../../src/durable-objects/project-data/tool-payload-cleanup';
import type { Env as WorkerEnv } from '../../src/env';
import { storeMcpToken } from '../../src/services/mcp-token';
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
        classifyStatus: (databaseSizeBytes) => classifyStorageUsage(databaseSizeBytes, config),
        recordTelemetry: async () => undefined,
      });
    })
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
           archive_version
         FROM tool_payload_archives
         WHERE message_id IN (${placeholders})
         ORDER BY message_created_at ASC, message_sequence ASC, message_id ASC`,
        ...messageIds
      )
      .toArray() as ArchiveRow[];
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
      { now: FIXED_NOW }
    );

    expect(result?.rowsUpdated).toBe(0);
    expect(result?.rowsFailed).toBe(1);
    expect(result?.recheckAt).toBe(FIXED_NOW + 60_000);
    const metadata = await readMessageMetadata(stub, seeded.messageIds);
    expect(Array.isArray(metadata.get(seeded.messageIds[0]!)?.content)).toBe(true);
    expect(await readArchiveRows(stub, seeded.messageIds)).toHaveLength(0);
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
    const object = await env.PROJECT_DATA_ARCHIVE_R2.get(archiveRows[0]!.r2_key);
    expect(object).not.toBeNull();
    const archived = JSON.parse((await object?.text()) ?? '{}') as Record<string, unknown>;
    expect(archived.messageId).toBe(seeded.messageIds[0]);
    expect((archived.toolMetadata as Record<string, unknown>).content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text' })])
    );
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
    expect(rowBudgetResult?.recheckAt).toBe(FIXED_NOW + 60_000);
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
    expect(byteBudgetResult?.recheckAt).toBe(FIXED_NOW + 60_000);
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
    expect(wallBudgetResult?.recheckAt).toBe(FIXED_NOW + 60_000);
    const wallMetadata = await readMessageMetadata(wallBudgetStub, wallBudgetSeeded.messageIds);
    expect(wallMetadata.get(wallBudgetSeeded.messageIds[0]!)?.content).toBeUndefined();
    expect(Array.isArray(wallMetadata.get(wallBudgetSeeded.messageIds[1]!)?.content)).toBe(true);
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
      createdAt: new Date(FIXED_NOW).toISOString(),
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
