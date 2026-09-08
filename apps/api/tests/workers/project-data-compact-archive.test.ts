import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import worker from '../../src/index';
import {
  copyBackProjectDataArchiveMigration,
  runScopedProjectDataArchiveCanary,
} from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import {
  countTargetMessages,
  projectDataStub,
  readLocation,
  seedMessages,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';
const testEnv = env as unknown as WorkerEnv;
const OWNER = 'compact-archive-owner';
const INSTALLATION = 'compact-archive-installation';

async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, {
    name: `Archive Bridge ${projectId}`,
  });
}

async function seedTerminalSessionWithMessages(
  projectId: string,
  count: number,
  streaming = false,
  tools = false
): Promise<{ source: DurableObjectStub<ProjectDataTestDouble>; sessionId: string }> {
  await seedProjectGraph(projectId);
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  const sessionId = await source.createSession(null, 'Bind limit transcript');
  await source.persistMessageBatch(
    sessionId,
    seedMessages(count).map((message, index) => {
      if (tools && index >= count - 2)
        return {
          ...message,
          role: 'tool',
          toolMetadata: JSON.stringify(
            index === count - 2
              ? { content: [{ type: 'text', text: 'inline tool result' }] }
              : { title: 'Archived tool' }
          ),
        };
      return streaming ? { ...message, role: index === 0 ? 'user' : 'assistant' } : message;
    })
  );
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  return { source, sessionId };
}

describe('compact R2 archive rollout', () => {
  it('defers without fencing, then migrates, reads and copies back through real R2 and SQLite', async () => {
    const projectId = `compact-archive-${crypto.randomUUID()}`;
    const { source, sessionId } = await seedTerminalSessionWithMessages(
      projectId,
      201,
      false,
      true
    );
    const archivedMessage = seedMessages(201)[200];
    const archivedAt = Date.now();
    const key = `legacy-tool/${projectId}`;
    const toolMetadata = { content: [{ type: 'text', text: 'legacy archived tool result' }] };
    await env.PROJECT_DATA_ARCHIVE_R2.put(
      key,
      JSON.stringify({
        version: 1,
        projectId,
        sessionId,
        messageId: archivedMessage.messageId,
        messageCreatedAt: 1_200_000,
        messageSequence: 201,
        toolMetadata,
      })
    );
    await runInDurableObject(source, async (_instance, state) =>
      state.storage.sql
        .exec(
          `INSERT INTO tool_payload_archives
      (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes, archived_at, message_created_at, message_sequence, archive_version)
      VALUES (?, ?, ?, 100, ?, ?, 1200000, 201, 1)`,
          archivedMessage.messageId,
          sessionId,
          key,
          JSON.stringify(toolMetadata).length,
          archivedAt
        )
        .toArray()
    );
    const mcpToken = crypto.randomUUID();
    await env.KV.put(
      `mcp:${mcpToken}`,
      JSON.stringify({
        taskId: '',
        contextType: 'conversation',
        taskMode: 'conversation',
        projectId,
        userId: OWNER,
        workspaceId: '',
        chatSessionId: sessionId,
        createdAt: new Date().toISOString(),
      }),
      { expirationTtl: 3600 }
    );
    const mcpRead = async (name: string, args: Record<string, unknown>) => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request('https://api.test.example.com/mcp', {
          method: 'POST',
          headers: { Authorization: `Bearer ${mcpToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        }),
        testEnv,
        context
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        error?: unknown;
        result: { content: Array<{ text: string }> };
      };
      expect(body.error).toBeUndefined();
      await waitOnExecutionContext(context);
      return JSON.parse(body.result.content[0]!.text);
    };
    let originalMcp: unknown;
    const verifyMcpReads = async () => {
      const history = await mcpRead('get_session_messages', { projectId, sessionId, limit: 300 });
      const scoped = await mcpRead('search_messages', { sessionId, query: 'payload', limit: 20 });
      const project = await mcpRead('search_messages', { query: 'payload', limit: 20 });
      expect(history.messages.length).toBeGreaterThan(0);
      expect(scoped.count).toBeGreaterThan(0);
      expect(
        project.results.some((row: { sessionId: string }) => row.sessionId === sessionId)
      ).toBe(true);
      const result = { history, scoped: scoped.results, project: project.results };
      if (originalMcp === undefined) originalMcp = result;
      else expect(result).toEqual(originalMcp);
    };
    const verifyToolsAndSearch = async () => {
      await verifyMcpReads();
      expect(
        await projectDataService.getMessageCount(testEnv, projectId, sessionId, ['tool'])
      ).toBe(2);
      expect(
        await projectDataService.getMessageToolContent(
          testEnv,
          projectId,
          sessionId,
          seedMessages(201)[199].messageId
        )
      ).toMatchObject({
        source: 'inline',
        content: [{ type: 'text', text: 'inline tool result' }],
      });
      expect(
        await projectDataService.getMessageToolContent(
          testEnv,
          projectId,
          sessionId,
          archivedMessage.messageId
        )
      ).toMatchObject({ source: 'archive', content: toolMetadata.content });
      const payloads = await projectDataService.getArchivedToolPayloads(testEnv, projectId, {
        sessionId,
        limit: 10,
      });
      expect(payloads.payloads).toEqual([
        expect.objectContaining({
          messageId: archivedMessage.messageId,
          available: true,
          content: toolMetadata.content,
        }),
      ]);
      expect(
        (await projectDataService.searchMessages(testEnv, projectId, 'payload', sessionId)).length
      ).toBeGreaterThan(0);
      expect(
        (await projectDataService.searchMessages(testEnv, projectId, 'payload')).some(
          (row) => row.sessionId === sessionId
        )
      ).toBe(true);
    };
    await verifyToolsAndSearch();
    const original = await projectDataService.getMessages(
      testEnv,
      projectId,
      sessionId,
      300,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '0',
      },
      async () => {
        const result = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'compact budget refusal test',
          nowDate: new Date(Date.now() + 60_000),
        });
        expect(result.stats).toMatchObject({ migrated: 0, failed: 0, budgetDeferred: 1 });
        expect(await readLocation(projectId, sessionId)).toBeNull();
        expect(await source.getMessageCount(sessionId)).toBe(201);
      }
    );
    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '1000000',
      },
      async () => {
        const result = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'compact full roundtrip test',
          nowDate: new Date(Date.now() + 60_000),
        });
        expect(result.stats).toMatchObject({ migrated: 1, failed: 0 });
        const location = await readLocation(projectId, sessionId);
        expect(location?.location_state).toBe('archive_shard');
        if (!location?.migration_id) throw new Error('Migration missing');
        expect(await countTargetMessages(location.owner_name, sessionId)).toBe(0);
        expect(await source.getMessageCount(sessionId)).toBe(0);
        await verifyToolsAndSearch();
        expect(
          await projectDataService.getMessages(
            testEnv,
            projectId,
            sessionId,
            300,
            null,
            null,
            undefined,
            false,
            'asc'
          )
        ).toEqual(original);
        await withArchiveEnv({ PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'false' }, async () => {
          await verifyMcpReads();
          expect(
            await projectDataService.getMessages(
              testEnv,
              projectId,
              sessionId,
              300,
              null,
              null,
              undefined,
              false,
              'asc'
            )
          ).toEqual(original);
          const result = await copyBackProjectDataArchiveMigration(testEnv, {
            projectId,
            migrationId: location.migration_id as string,
            reason: 'verify lossless compact recovery',
          });
          expect(result.restoredToRoot).toBe(true);
          await verifyToolsAndSearch();
          expect(
            await projectDataService.getMessages(
              testEnv,
              projectId,
              sessionId,
              300,
              null,
              null,
              undefined,
              false,
              'asc'
            )
          ).toEqual(original);
        });
        // A completed recovery must permit a new generation, while old recovery
        // RPCs remain fenced from the successor's transcript.
        const remigrated = await runScopedProjectDataArchiveCanary(testEnv, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'remigrate verified copy-back',
          nowDate: new Date(Date.now() + 120_000),
        });
        expect(remigrated.stats).toMatchObject({ migrated: 1, failed: 0 });
        const successor = await readLocation(projectId, sessionId);
        expect(successor?.migration_id).not.toBe(location.migration_id);
        expect(successor?.location_state).toBe('archive_shard');
        await expect(
          copyBackProjectDataArchiveMigration(testEnv, {
            projectId,
            migrationId: location.migration_id,
            reason: 'stale recovery must not modify successor',
          })
        ).rejects.toThrow(/identity mismatch/);
        await verifyToolsAndSearch();
        const recovered = await copyBackProjectDataArchiveMigration(testEnv, {
          projectId,
          migrationId: successor!.migration_id!,
          reason: 'recover successor',
        });
        expect(recovered.restoredToRoot).toBe(true);
        await verifyMcpReads();
      }
    );
  });

  it('shares an atomic durable allowance across concurrent attempts, retries and UTC windows', async () => {
    const { reserveArchiveWrites, ARCHIVE_BUDGET_WINDOW_MS } =
      await import('../../src/project-data-archive/write-budget');
    await env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget').run();
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserveArchiveWrites(env.DATABASE, 3000, 10_000, now))
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await reserveArchiveWrites(env.DATABASE, 1001, 10_000, now)).toBe(false);
    expect(await reserveArchiveWrites(env.DATABASE, 1000, 10_000, now)).toBe(true);
    expect(await reserveArchiveWrites(env.DATABASE, 1, 10_000, now)).toBe(false);
    expect(
      await reserveArchiveWrites(env.DATABASE, 10001, 10_000, now + ARCHIVE_BUDGET_WINDOW_MS)
    ).toBe(false);
    expect(
      await reserveArchiveWrites(env.DATABASE, 10_000, 10_000, now + ARCHIVE_BUDGET_WINDOW_MS)
    ).toBe(true);
    expect(await reserveArchiveWrites(env.DATABASE, 1, 10_000, now)).toBe(false);
  });
});

describe('compact archive SQL cost measurement', () => {
  it('reduces measured target writes for the same consolidated streaming transcript', async () => {
    const archive = await import('../../src/durable-objects/project-data/archive-sharding');
    const { writeCompactChunk } = await import('../../src/project-data-archive/compact-r2');
    const { PROJECT_DATA_ARCHIVE_TABLES } = await import('../../src/project-data-archive/contract');
    const measurements: number[] = [];
    for (const storageFormat of ['sqlite-v1', 'r2-gzip-v1'] as const) {
      const projectId = `compact-cost-${crypto.randomUUID()}`;
      const { source, sessionId } = await seedTerminalSessionWithMessages(projectId, 1001, true);
      const targetOwnerName = `${projectId}:archive:g1:s0`;
      const base = {
        projectId,
        sessionId,
        migrationId: crypto.randomUUID(),
        sourceOwnerName: projectId,
        targetOwnerName,
        targetGeneration: 1,
        sourceIntentToken: crypto.randomUUID(),
        now: Date.now() + 60_000,
        minTerminalAgeMs: 0,
      };
      const prepared = await source.archiveSourcePrepareIntent(base);
      if ('refused' in prepared) throw new Error('Cost fixture refused');
      const target = projectDataStub(targetOwnerName);
      await target.ensureProjectId(projectId);
      const chunks = [];
      for (const tableName of PROJECT_DATA_ARCHIVE_TABLES) {
        let cursor: string | null = null;
        let ordinal = 0;
        do {
          const chunk = await source.archiveSourceExportChunk({
            ...base,
            tableName,
            cursor,
            ordinal,
            maxRows: 500,
            maxBytes: 1024 * 1024,
          });
          chunks.push(chunk);
          cursor = chunk.hasMore ? chunk.cursor : null;
          ordinal++;
        } while (cursor);
      }
      const result = await runInDurableObject(target, async (_instance, state) => {
        let writes = 0;
        const sql = new Proxy(state.storage.sql, {
          get(object, property) {
            if (property === 'exec')
              return (query: string, ...params: unknown[]) => {
                const result = object.exec(query, ...params);
                writes += result.rowsWritten;
                return result;
              };
            return Reflect.get(object, property, object);
          },
        });
        archive.prepareArchiveTarget(sql, {
          ...base,
          storageFormat,
          terminalVersionSha256: prepared.terminalVersionSha256,
          expectedMessageCount: prepared.messageCount,
          sessionRow: prepared.sessionRow,
        });
        for (const chunk of chunks) {
          const rawChunkRef =
            storageFormat === 'r2-gzip-v1' && chunk.tableName === 'chat_messages'
              ? await writeCompactChunk(env.PROJECT_DATA_ARCHIVE_R2, 'cost-test', chunk)
              : undefined;
          await archive.commitArchiveTargetChunk(
            sql,
            { ...chunk, rawChunkRef, now: base.now },
            testEnv
          );
        }
        await archive.sealArchiveTarget(
          sql,
          {
            ...base,
            terminalVersionSha256: prepared.terminalVersionSha256,
            expectedChunkHashes: chunks.map((chunk) => chunk.sha256),
          },
          testEnv
        );
        return { writes, bytes: sql.databaseSize };
      });
      measurements.push(result.writes);
      console.info('compact archive cost fixture', storageFormat, JSON.stringify(result));
    }
    expect(measurements).toMatchSnapshot(
      'legacy and compact SQL writes for 1001 streaming fragments'
    );
    expect(measurements[0]).toBeGreaterThan(1000);
    expect(measurements[1]).toBeLessThan(measurements[0] * 0.2);
  });
});

describe('compact archive concurrent mutation fencing', () => {
  it('serializes duplicate chunk commits across R2 awaits before abandoning a partial target', async () => {
    const { writeCompactChunk } = await import('../../src/project-data-archive/compact-r2');
    const projectId = `compact-concurrency-${crypto.randomUUID()}`;
    const { source, sessionId } = await seedTerminalSessionWithMessages(projectId, 10, true);
    const base = {
      projectId,
      sessionId,
      migrationId: crypto.randomUUID(),
      sourceOwnerName: projectId,
      targetOwnerName: `${projectId}:archive:g1:s0`,
      targetGeneration: 1,
      sourceIntentToken: crypto.randomUUID(),
      now: Date.now() + 60_000,
      minTerminalAgeMs: 0,
    };
    const prepared = await source.archiveSourcePrepareIntent(base);
    if ('refused' in prepared) throw new Error('Concurrency fixture refused');
    const target = projectDataStub(base.targetOwnerName);
    await target.ensureProjectId(projectId);
    await target.archiveTargetPrepare({
      ...base,
      storageFormat: 'r2-gzip-v1',
      terminalVersionSha256: prepared.terminalVersionSha256,
      expectedMessageCount: prepared.messageCount,
      sessionRow: prepared.sessionRow,
    });
    const chunk = await source.archiveSourceExportChunk({
      ...base,
      tableName: 'chat_messages',
      ordinal: 0,
      maxRows: 500,
    });
    const rawChunkRef = await writeCompactChunk(env.PROJECT_DATA_ARCHIVE_R2, 'concurrency', chunk);
    const results = await Promise.all([
      target.archiveTargetCommitChunk({ ...chunk, rawChunkRef, now: base.now }),
      target.archiveTargetCommitChunk({ ...chunk, rawChunkRef, now: base.now }),
    ]);
    expect(results.map((result) => result.idempotent).sort()).toEqual([false, true]);
    await target.archiveTargetAbandonSession({ ...base, sourceIntactVerified: true });
    expect(
      await runInDurableObject(
        target,
        async (_instance, state) =>
          state.storage.sql
            .exec(
              'SELECT COUNT(*) AS n FROM project_data_archive_raw_chunks WHERE session_id = ?',
              sessionId
            )
            .toArray()[0]?.n
      )
    ).toBe(0);
    expect(await source.getMessageCount(sessionId)).toBe(10);
  });
});

describe('compact coordinator restart and contention', () => {
  it('retains its journaled format and write admission after interruption before target creation', async () => {
    await env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget').run();
    const projectId = `compact-resume-${crypto.randomUUID()}`;
    const { sessionId } = await seedTerminalSessionWithMessages(projectId, 10, true);
    const owners = new Map<string, string>();
    const interruptedNamespace = {
      idFromName(name: string) {
        const id = env.PROJECT_DATA.idFromName(name);
        owners.set(id.toString(), name);
        return id;
      },
      get(id: DurableObjectId) {
        const stub = env.PROJECT_DATA.get(id);
        if (!owners.get(id.toString())?.includes(':archive:')) return stub;
        return {
          ensureProjectId: (project: string) => stub.ensureProjectId(project),
          archiveTargetPrepare: async () => {
            throw new Error('injected coordinator interruption before target creation');
          },
        };
      },
    } as unknown as WorkerEnv['PROJECT_DATA'];
    const base = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
      PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '100000',
    };
    const args = {
      projectId,
      sessionId,
      dryRun: false,
      reason: 'resume format proof',
      nowDate: new Date(Date.now() + 60_000),
    };
    const failed = await runScopedProjectDataArchiveCanary(
      { ...base, PROJECT_DATA: interruptedNamespace },
      args
    );
    expect(failed.stats).toMatchObject({ failed: 1, migrated: 0 });
    const journal = await env.DATABASE.prepare(
      'SELECT storage_format, state FROM project_data_archive_migrations WHERE project_id = ?'
    )
      .bind(projectId)
      .first();
    expect(journal).toMatchObject({ storage_format: 'r2-gzip-v1', state: 'failed' });
    const paused = await runScopedProjectDataArchiveCanary(
      {
        ...base,
        PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'false',
        PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '0',
      },
      args
    );
    expect(paused.stats).toMatchObject({ migrated: 0, failed: 0, budgetDeferred: 1 });
    const resumed = await runScopedProjectDataArchiveCanary(
      { ...base, PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'false' },
      args
    );
    expect(resumed.stats).toMatchObject({ migrated: 1, failed: 0 });
    const location = await readLocation(projectId, sessionId);
    if (!location) throw new Error('Missing location');
    expect(await countTargetMessages(location.owner_name, sessionId)).toBe(0);
    const target = await projectDataStub(location.owner_name).archiveTargetInspectSession({
      projectId,
      sessionId,
      migrationId: location.migration_id,
      targetOwnerName: location.owner_name,
      targetGeneration: location.generation,
    });
    expect(target.storageFormat).toBe('r2-gzip-v1');
  });

  it('releases only unused same-session contender reservations, exactly once and never across days', async () => {
    const { releaseUnusedArchiveReservation, reserveArchiveWrites, ARCHIVE_BUDGET_WINDOW_MS } =
      await import('../../src/project-data-archive/write-budget');
    const projectId = `compact-contention-${crypto.randomUUID()}`;
    const { source, sessionId } = await seedTerminalSessionWithMessages(projectId, 10, true);
    await env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget').run();
    const estimate = await source.archiveSourceEstimateWrites(sessionId, 32, 5000);
    const nowDate = new Date(Date.now() + 60_000);
    const configured = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
      PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '100000',
    };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        runScopedProjectDataArchiveCanary(configured, {
          projectId,
          sessionId,
          dryRun: false,
          reason: 'same session concurrent canaries',
          nowDate,
        })
      )
    );
    expect(results.reduce((n, result) => n + result.stats.migrated, 0)).toBe(1);
    const budget = await env.DATABASE.prepare(
      'SELECT reserved_writes FROM project_data_archive_write_budget'
    ).first();
    expect(budget?.reserved_writes).toBe(estimate);
    const receipt = crypto.randomUUID();
    expect(await reserveArchiveWrites(env.DATABASE, 1000, 100000, nowDate.getTime())).toBe(true);
    await releaseUnusedArchiveReservation(env.DATABASE, receipt, 1000, nowDate.getTime());
    await releaseUnusedArchiveReservation(env.DATABASE, receipt, 1000, nowDate.getTime());
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT reserved_writes FROM project_data_archive_write_budget'
        ).first()
      )?.reserved_writes
    ).toBe(estimate);
    expect(
      await reserveArchiveWrites(
        env.DATABASE,
        1000,
        100000,
        nowDate.getTime() + ARCHIVE_BUDGET_WINDOW_MS
      )
    ).toBe(true);
    await releaseUnusedArchiveReservation(
      env.DATABASE,
      crypto.randomUUID(),
      estimate,
      nowDate.getTime()
    );
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT reserved_writes FROM project_data_archive_write_budget'
        ).first()
      )?.reserved_writes
    ).toBe(1000);
  });
});
