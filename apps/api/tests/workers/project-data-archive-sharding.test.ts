import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ArchiveRpcFence } from '../../src/durable-objects/project-data/archive-sharding';
import {
  ARCHIVE_AGGREGATE_CHAIN_SEED,
  archiveCanonicalBytes,
  extendCanonicalAggregateHash,
  sha256Hex,
} from '../../src/durable-objects/project-data/archive-sharding-canonical';
import type { Env } from '../../src/env';
import {
  requestProjectDataArchiveForwardFix,
  requestProjectDataArchiveRehome,
  runProjectDataArchiveShardingSweep,
} from '../../src/scheduled/project-data-archive-sharding';
import * as service from '../../src/services/project-data';
import { DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX } from '../../src/services/project-data-archive-types';
import { isProjectDataSessionWakeAllowed } from '../../src/services/session-snapshot-recovery-lifecycle';
import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as Env;

function stub(ownerName: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(ownerName);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<void> {
  const userId = `user-${projectId}`;
  const installationId = `installation-${projectId}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId, {
    installationIdValue: `external-${projectId}`,
  });
  await seedProject(projectId, userId, installationId);
}

async function runUntilOneArchive(coordinatorEnv: Env, maxSweeps = 20): Promise<void> {
  for (let attempt = 0; attempt < maxSweeps; attempt++) {
    const sweep = await runProjectDataArchiveShardingSweep(coordinatorEnv, Date.now());
    expect(sweep.failed).toBe(0);
    expect(sweep.frozen).toBe(0);
    if (sweep.archived === 1) return;
  }
  const diagnostics = await env.DATABASE.prepare(
    `SELECT migration_id, state, next_table_name, next_chunk_index,
            recovery_verify_page_key, recovery_verify_entry_index,
            recovery_verified_at, failure_count, last_error
       FROM project_data_archive_migrations
      WHERE state != 'archived' ORDER BY updated_at DESC LIMIT 5`
  ).all();
  throw new Error(
    `ProjectData archive did not complete within ${maxSweeps} bounded sweeps: ${JSON.stringify(diagnostics.results)}`
  );
}

async function planMigration(
  projectId: string,
  sessionId: string,
  terminalVersion: string,
  targetOwner: string
): Promise<ArchiveRpcFence> {
  const migrationId = crypto.randomUUID();
  const now = Date.now();
  const fence: ArchiveRpcFence = {
    projectId,
    sessionId,
    migrationId,
    ownerName: targetOwner,
    generation: 1,
    leaseToken: crypto.randomUUID(),
    leaseEpoch: 1,
    leaseExpiresAt: now + 10 * 60_000,
    terminalVersion,
  };
  await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations
       (project_id, session_id, state, owner_kind, owner_name, generation,
        migration_id, routing_version, updated_at)
       VALUES (?, ?, 'migrating', 'root', ?, 0, ?, 1, ?)`
    ).bind(projectId, sessionId, projectId, migrationId, now),
    env.DATABASE.prepare(
      `INSERT INTO project_data_archive_migrations
       (migration_id, project_id, session_id, state, source_owner_name,
        source_generation, target_owner_name, target_generation, lease_token,
        lease_epoch, lease_expires_at, terminal_version, next_table_name,
        next_chunk_index, created_at, updated_at)
       VALUES (?, ?, ?, 'copying', ?, 0, ?, 1, ?, 1, ?, ?, 'chat_messages', 0, ?, ?)`
    ).bind(
      migrationId,
      projectId,
      sessionId,
      projectId,
      targetOwner,
      fence.leaseToken,
      fence.leaseExpiresAt,
      terminalVersion,
      now,
      now
    ),
  ]);
  return fence;
}

async function sealTargetWithPagedManifest(
  target: DurableObjectStub<ProjectDataTestDouble>,
  fence: ArchiveRpcFence,
  sourceGeneration: number,
  prefix: string,
  pageSize = 2
): Promise<{ aggregateHash: string; manifestR2Key: string; entryCount: number }> {
  const recoveryPrefix = `${prefix}/${encodeURIComponent(fence.projectId)}/${encodeURIComponent(fence.sessionId)}/${encodeURIComponent(fence.migrationId)}/from-${sourceGeneration}-to-${fence.generation}`;
  await target.archiveBeginTargetSealing(fence);
  for (;;) {
    const verification = await target.archiveVerifyNextTargetChunk(fence);
    if (verification.done) break;
  }
  for (;;) {
    const page = await target.archiveGetNextTargetManifestPage(fence, pageSize);
    if (page.done) {
      const aggregateHash = page.previousChainHash;
      const manifestBody = JSON.stringify({
        version: 2,
        projectId: fence.projectId,
        sessionId: fence.sessionId,
        migrationId: fence.migrationId,
        sourceOwnerName: sourceGeneration === 0 ? fence.projectId : 'source-archive-owner',
        sourceGeneration,
        targetOwnerName: fence.ownerName,
        targetGeneration: fence.generation,
        terminalVersion: fence.terminalVersion,
        aggregateHash,
        headPageKey: page.previousPageKey,
        pageCount: page.pageIndex,
        entryCount: page.entryCount,
      });
      const manifestHash = await sha256Hex(manifestBody);
      const manifestR2Key = `${recoveryPrefix}/manifest-${manifestHash}.json`;
      await env.PROJECT_DATA_ARCHIVE_R2.put(manifestR2Key, manifestBody, {
        customMetadata: { objectHash: manifestHash },
      });
      await target.archiveSealTarget(fence, aggregateHash, manifestR2Key);
      return { aggregateHash, manifestR2Key, entryCount: page.entryCount };
    }
    const aggregateHashAfterPage = await extendCanonicalAggregateHash(
      page.previousChainHash,
      page.entries
    );
    const pageBody = JSON.stringify({
      version: 2,
      projectId: fence.projectId,
      sessionId: fence.sessionId,
      migrationId: fence.migrationId,
      sourceGeneration,
      targetGeneration: fence.generation,
      pageIndex: page.pageIndex,
      previousPageKey: page.previousPageKey,
      previousChainHash: page.previousChainHash,
      aggregateHashAfterPage,
      entries: page.entries,
    });
    const pageHash = await sha256Hex(pageBody);
    const pageR2Key = `${recoveryPrefix}/manifest-page-${page.pageIndex}-${pageHash}.json`;
    await env.PROJECT_DATA_ARCHIVE_R2.put(pageR2Key, pageBody, {
      customMetadata: { objectHash: pageHash },
    });
    await target.archiveCommitTargetManifestPage(
      fence,
      {
        pageIndex: page.pageIndex,
        previousPageKey: page.previousPageKey,
        previousChainHash: page.previousChainHash,
        entryCount: page.entryCount,
        entries: page.entries,
      },
      pageR2Key,
      aggregateHashAfterPage
    );
  }
}

describe('ProjectData terminal archive sharding', () => {
  it('copies bounded chunks, seals by committed-row hashes, preserves the root anchor, and routes exact reads', async () => {
    const suffix = crypto.randomUUID();
    const projectId = `archive-project-${suffix}`;
    const targetOwner = `project-data-archive:${projectId}:0`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Archive me');
    const waitParentTaskId = `archive-wait-parent-${suffix}`;
    const waitChildTaskId = `archive-wait-child-${suffix}`;
    const userId = `user-${projectId}`;
    await seedTask(waitParentTaskId, projectId, userId, { status: 'in_progress' });
    await seedTask(waitChildTaskId, projectId, userId, { status: 'in_progress' });
    await env.DATABASE.prepare(`UPDATE tasks SET chat_session_id = ? WHERE id = ?`)
      .bind(sessionId, waitParentTaskId)
      .run();
    const taskWait = await source.registerTaskWait({
      parentTaskId: waitParentTaskId,
      parentSessionId: sessionId,
      idempotencyKey: `archive-fence-${suffix}`,
      condition: 'all',
      childTaskIds: [waitChildTaskId],
      wakeDeadline: Date.now() + 60 * 60_000,
    });
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE task_wait_subscriptions SET next_reconcile_at = ? WHERE id = ?`,
        Date.now() + 60 * 60_000,
        taskWait.subscription.id
      );
    });
    await env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .bind(waitParentTaskId)
      .run();
    const messageIds: string[] = [];
    for (let index = 0; index < 6; index++) {
      messageIds.push(
        await source.persistMessage(
          sessionId,
          index === 5 ? 'plan' : index === 0 ? 'tool' : index % 2 === 0 ? 'user' : 'assistant',
          index === 5
            ? JSON.stringify([{ step: 'archive safely', status: 'completed' }])
            : `${index}-${'terminal transcript '.repeat(2_000)}`,
          index === 0
            ? JSON.stringify({
                toolCallId: 'archive-tool-call',
                title: 'Archived tool',
                status: 'completed',
                toolPayloadArchived: true,
              })
            : null
        )
      );
    }
    const archivedToolContent = [{ type: 'text', text: 'private archived tool payload' }];
    const archivedToolMetadata = JSON.stringify({
      toolCallId: 'archive-tool-call',
      content: archivedToolContent,
    });
    const toolArchiveKey = `project-data/tool-payloads/${projectId}/${sessionId}/${messageIds[0]}.json`;
    await env.PROJECT_DATA_ARCHIVE_R2.put(
      toolArchiveKey,
      JSON.stringify({
        version: 1,
        projectId,
        sessionId,
        messageId: messageIds[0],
        messageCreatedAt: 1,
        messageSequence: 0,
        archivedAt: 2,
        contentBytes: new TextEncoder().encode(JSON.stringify(archivedToolContent)).byteLength,
        toolMetadataBytes: new TextEncoder().encode(archivedToolMetadata).byteLength,
        toolMetadata: JSON.parse(archivedToolMetadata),
      })
    );
    await runInDurableObject(source, async (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT created_at, sequence FROM chat_messages WHERE id = ?', messageIds[0]!)
        .one();
      state.storage.sql.exec(
        `INSERT INTO tool_payload_archives
         (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes,
          archived_at, message_created_at, message_sequence, archive_version)
         VALUES (?, ?, ?, ?, ?, 2, ?, ?, 1)`,
        messageIds[0]!,
        sessionId,
        toolArchiveKey,
        new TextEncoder().encode(JSON.stringify(archivedToolContent)).byteLength,
        new TextEncoder().encode(archivedToolMetadata).byteLength,
        row.created_at as number,
        row.sequence as number
      );
    });
    expect(await source.stopSession(sessionId)).toBe(true);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET ended_at = ?, updated_at = ? WHERE id = ?',
        Date.now() - 100_000,
        Date.now() - 100_000,
        sessionId
      );
    });
    const eligibility = await source.archiveInspectSourceEligibility(
      projectId,
      sessionId,
      Date.now(),
      1_000
    );
    expect(eligibility).toMatchObject({ eligible: true, reason: null });
    expect(eligibility.terminalVersion).toBeTruthy();
    let fence = await planMigration(
      projectId,
      sessionId,
      eligibility.terminalVersion!,
      targetOwner
    );
    const anchor = await source.archiveGetSourceSessionAnchor(projectId, sessionId);
    const recoveryPrefix = `${DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX}/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(fence.migrationId)}/from-0-to-1`;
    await source.archiveEstablishSourceIntent(fence);
    expect(
      (
        await source.rootSearchAuthoritativeMessages(projectId, 'terminal transcript', null, 20)
      ).some((message) => message.sessionId === sessionId)
    ).toBe(false);
    await expect(
      service.persistMessage(testEnv, projectId, sessionId, 'user', 'late service write', null)
    ).rejects.toThrow('migration is in progress');
    await expect(
      service.persistMessageBatch(testEnv, projectId, sessionId, [
        {
          messageId: crypto.randomUUID(),
          role: 'user',
          content: 'late service batch',
          toolMetadata: null,
          timestamp: new Date().toISOString(),
        },
      ])
    ).rejects.toThrow('migration is in progress');
    const directSourceWrite = await captureProjectDataExpectedError(source, {
      operation: 'persistMessage',
      args: [sessionId, 'user', 'late direct write', null],
    });
    expect(directSourceWrite).toMatchObject({ threw: true });
    expect(directSourceWrite.message).toContain('archive source');
    const directSourceBatch = await captureProjectDataExpectedError(source, {
      operation: 'persistMessageBatch',
      args: [
        sessionId,
        [
          {
            messageId: crypto.randomUUID(),
            role: 'user',
            content: 'late direct batch',
            toolMetadata: null,
            timestamp: new Date().toISOString(),
          },
        ],
      ],
    });
    expect(directSourceBatch).toMatchObject({ threw: true });
    expect(directSourceBatch.message).toContain('archive source');
    const target = stub(targetOwner);
    await target.ensureProjectId(projectId);
    const changedProjectIdentity = await captureProjectDataExpectedError(target, {
      operation: 'ensureProjectId',
      args: ['different-project'],
    });
    expect(changedProjectIdentity).toMatchObject({ threw: true });
    expect(changedProjectIdentity.message).toContain('identity mismatch');
    const malformedOwner = `project-data-archive:different-project:0`;
    const malformedTarget = stub(malformedOwner);
    await malformedTarget.ensureProjectId(projectId);
    const malformedTargetIdentity = await captureProjectDataExpectedError(malformedTarget, {
      operation: 'archivePrepareTarget',
      args: [{ ...fence, ownerName: malformedOwner }, anchor],
    });
    expect(malformedTargetIdentity).toMatchObject({ threw: true });
    expect(malformedTargetIdentity.message).toContain(
      'project/owner/generation identity is invalid'
    );
    await target.archivePrepareTarget(fence, anchor);

    const oversizedSourceRpc = await captureProjectDataExpectedError(source, {
      operation: 'archiveReadSourceChunk',
      args: [fence, 'chat_messages', 0, null, 129, 256 * 1024],
    });
    expect(oversizedSourceRpc).toMatchObject({ threw: true });
    expect(oversizedSourceRpc.message).toContain('exceeds configured protocol limits');
    const oversizedManifestRpc = await captureProjectDataExpectedError(target, {
      operation: 'archiveGetNextTargetManifestPage',
      args: [fence, 9],
    });
    expect(oversizedManifestRpc).toMatchObject({ threw: true });
    expect(oversizedManifestRpc.message).toContain('exceeds configured protocol limits');
    const oversizedTargetRpc = await captureProjectDataExpectedError(target, {
      operation: 'archiveCommitTargetChunk',
      args: [
        fence,
        {
          table: 'chat_messages',
          chunkIndex: 0,
          afterKey: null,
          nextKey: null,
          done: true,
          rows: [],
          rowCount: 129,
          canonicalBytes: 1,
          canonicalHash: '0'.repeat(64),
        },
        'archive-test/oversized.json',
      ],
    });
    expect(oversizedTargetRpc).toMatchObject({ threw: true });
    expect(oversizedTargetRpc.message).toContain('exceeds configured protocol limits');

    for (const table of [
      'chat_messages',
      'chat_messages_grouped',
      'tool_payload_archives',
    ] as const) {
      let afterKey: string | null = null;
      let chunkIndex = 0;
      let hasMore = true;
      while (hasMore) {
        const chunk = await source.archiveReadSourceChunk(
          fence,
          table,
          chunkIndex,
          afterKey,
          2,
          256 * 1024
        );
        expect(chunk.canonicalBytes).toBeLessThan(32 * 1024 * 1024);
        const r2Key = `${recoveryPrefix}/${table}/${chunkIndex}-${chunk.canonicalHash}.json`;
        const chunkBody = archiveCanonicalBytes(table, chunk.rows);
        await env.PROJECT_DATA_ARCHIVE_R2.put(r2Key, chunkBody, {
          customMetadata: { objectHash: chunk.canonicalHash },
        });
        if (table === 'chat_messages' && chunkIndex === 0) {
          const mismatch = await runInDurableObject(target, async (instance) => {
            try {
              await instance.archiveCommitTargetChunk(
                fence,
                { ...chunk, canonicalHash: '0'.repeat(64) },
                r2Key
              );
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          });
          expect(mismatch).toContain('input hash mismatch');
        }
        await target.archiveCommitTargetChunk(fence, chunk, r2Key);
        await target.archiveCommitTargetChunk(fence, chunk, r2Key);
        afterKey = chunk.nextKey;
        chunkIndex++;
        hasMore = !chunk.done;
      }
    }

    await target.archiveBeginTargetSealing(fence);
    const tampered = await runInDurableObject(target, async (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT id, content FROM chat_messages WHERE session_id = ? ORDER BY id LIMIT 1',
          sessionId
        )
        .toArray()[0];
      state.storage.sql.exec(
        'UPDATE chat_messages SET content = ? WHERE id = ?',
        'tampered after commit',
        row?.id as string
      );
      return { id: row?.id as string, content: row?.content as string };
    });
    const committedMismatch = await runInDurableObject(target, async (instance) => {
      try {
        await instance.archiveVerifyNextTargetChunk(fence);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(committedMismatch).toContain('committed-row hash mismatch');
    await runInDurableObject(target, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_messages SET content = ? WHERE id = ?',
        tampered.content,
        tampered.id
      );
    });
    const originalToolArchiveKey = await runInDurableObject(target, async (_instance, state) => {
      const row = state.storage.sql
        .exec('SELECT r2_key FROM tool_payload_archives WHERE message_id = ?', messageIds[0]!)
        .one();
      state.storage.sql.exec(
        `UPDATE tool_payload_archives SET r2_key = 'tampered-tool-manifest-key'
         WHERE message_id = ?`,
        messageIds[0]!
      );
      return row.r2_key as string;
    });
    const toolManifestMismatch = await runInDurableObject(target, async (instance) => {
      try {
        instance.archiveBeginTargetSealing(fence);
        for (;;) {
          const verification = await instance.archiveVerifyNextTargetChunk(fence);
          if (verification.done) return null;
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(toolManifestMismatch).toContain('committed-row hash mismatch');
    await runInDurableObject(target, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE tool_payload_archives SET r2_key = ? WHERE message_id = ?',
        originalToolArchiveKey,
        messageIds[0]!
      );
    });
    const sealed = await sealTargetWithPagedManifest(
      target,
      fence,
      0,
      DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX
    );
    expect(sealed.entryCount).toBeGreaterThan(3);
    const { aggregateHash, manifestR2Key } = sealed;
    expect(aggregateHash).not.toBe(ARCHIVE_AGGREGATE_CHAIN_SEED);
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
       SET next_table_name = NULL, lease_expires_at = 0
       WHERE migration_id = ? AND state = 'copying'`
    )
      .bind(fence.migrationId)
      .run();
    const sealGapEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
    };
    await expect(runProjectDataArchiveShardingSweep(sealGapEnv, Date.now())).resolves.toMatchObject(
      { archived: 0, failed: 0, frozen: 0 }
    );
    const sealedJournal = await env.DATABASE.prepare(
      `SELECT state, aggregate_hash, manifest_r2_key
       FROM project_data_archive_migrations WHERE migration_id = ?`
    )
      .bind(fence.migrationId)
      .first<{
        state: string;
        aggregate_hash: string;
        manifest_r2_key: string;
      }>();
    expect(sealedJournal).toMatchObject({
      state: 'sealed',
      aggregate_hash: aggregateHash,
      manifest_r2_key: manifestR2Key,
    });
    const refreshedFence = await runInDurableObject(source, async (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT lease_token, lease_epoch, lease_expires_at
           FROM project_data_archive_source_intents WHERE migration_id = ?`,
          fence.migrationId
        )
        .one()
    );
    fence = {
      ...fence,
      leaseToken: refreshedFence.lease_token as string,
      leaseEpoch: refreshedFence.lease_epoch as number,
      leaseExpiresAt: refreshedFence.lease_expires_at as number,
    };

    await env.DATABASE.prepare(
      'UPDATE project_data_archive_migrations SET lease_expires_at = 0 WHERE migration_id = ?'
    )
      .bind(fence.migrationId)
      .run();
    const expiredFinalize = await runInDurableObject(source, async (instance) => {
      try {
        await instance.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(expiredFinalize).toContain('D1 finalize fence mismatch');
    await env.DATABASE.prepare(
      'UPDATE project_data_archive_migrations SET lease_expires_at = ? WHERE migration_id = ?'
    )
      .bind(fence.leaseExpiresAt, fence.migrationId)
      .run();

    const priorUpdatedAt = await runInDurableObject(source, async (_instance, state) => {
      const updatedAt = state.storage.sql
        .exec('SELECT updated_at FROM chat_sessions WHERE id = ?', sessionId)
        .one().updated_at as number;
      state.storage.sql.exec(
        'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
        updatedAt + 1,
        sessionId
      );
      return updatedAt;
    });
    const changedVersionFinalize = await captureProjectDataExpectedError(source, {
      operation: 'archiveFinalizeSource',
      args: [fence, aggregateHash, manifestR2Key],
    });
    expect(changedVersionFinalize).toMatchObject({ threw: true });
    expect(changedVersionFinalize.message).toContain('terminal version changed');
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
        priorUpdatedAt,
        sessionId
      );
    });

    // Reuse the session's existing task binding: tasks.chat_session_id is
    // unique, so attempting to seed a second owner would be ignored and would
    // not exercise the finalize-time live-task fence.
    await env.DATABASE.prepare(`UPDATE tasks SET status = 'ready' WHERE id = ?`)
      .bind(waitParentTaskId)
      .run();
    const liveTaskFinalize = await captureProjectDataExpectedError(source, {
      operation: 'archiveFinalizeSource',
      args: [fence, aggregateHash, manifestR2Key],
    });
    expect(liveTaskFinalize).toMatchObject({ threw: true });
    expect(liveTaskFinalize.message).toContain('D1 finalize fence mismatch');
    await env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .bind(waitParentTaskId)
      .run();

    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations SET owner_name = 'wrong-root-owner'
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, sessionId)
      .run();
    const wrongLocationFinalize = await captureProjectDataExpectedError(source, {
      operation: 'archiveFinalizeSource',
      args: [fence, aggregateHash, manifestR2Key],
    });
    expect(wrongLocationFinalize).toMatchObject({ threw: true });
    expect(wrongLocationFinalize.message).toContain('D1 finalize fence mismatch');
    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations SET owner_name = ?
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, projectId, sessionId)
      .run();

    const lateSnapshotId = `late-${fence.migrationId}`;
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
       (id, project_id, user_id, chat_session_id, runtime, status, degradation,
        manifest_r2_key, expires_at, sleep_status, sleeping_at, recovery_attempts, updated_at)
       VALUES (?, ?, ?, ?, 'vm', 'available', 'none', ?, ?, 'sleeping', ?, 0, ?)`
    )
      .bind(
        lateSnapshotId,
        projectId,
        `user-${projectId}`,
        sessionId,
        `snapshots/${sessionId}/late.json`,
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
    const dependencyRace = await runInDurableObject(source, async (instance) => {
      try {
        await instance.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(dependencyRace).toContain('D1 finalize fence mismatch');
    await env.DATABASE.prepare('DELETE FROM session_snapshots WHERE id = ?')
      .bind(lateSnapshotId)
      .run();

    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO comment_threads
         (id, session_id, message_id, body, author_type, author_id,
          status, created_at, updated_at, sequence, version)
         VALUES ('finalize-race', ?, ?, 'race', 'human', 'test', 'open', 1, 1, 1, 1)`,
        sessionId,
        messageIds[0]!
      );
    });
    const commentRace = await runInDurableObject(source, async (instance) => {
      try {
        await instance.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(commentRace).toContain('message comments exist');
    await runInDurableObject(source, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?', sessionId)
          .one().cnt
      ).toBe(6);
      state.storage.sql.exec("DELETE FROM comment_threads WHERE id = 'finalize-race'");
    });

    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec('DROP TABLE chat_messages_grouped_fts');
      state.storage.sql.exec(
        'CREATE TABLE chat_messages_grouped_fts (rowid INTEGER PRIMARY KEY, content TEXT)'
      );
    });
    const ftsFailure = await runInDurableObject(source, async (instance) => {
      try {
        await instance.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(ftsFailure).toBeTruthy();
    await runInDurableObject(source, async (_instance, state) => {
      expect(
        state.storage.sql
          .exec('SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?', sessionId)
          .one().cnt
      ).toBe(6);
      state.storage.sql.exec('DROP TABLE chat_messages_grouped_fts');
      state.storage.sql.exec(
        `CREATE VIRTUAL TABLE chat_messages_grouped_fts USING fts5(
           content, content='chat_messages_grouped', content_rowid='rowid'
         )`
      );
      state.storage.sql.exec(
        `INSERT INTO chat_messages_grouped_fts(rowid, content)
         SELECT rowid, content FROM chat_messages_grouped WHERE session_id = ?`,
        sessionId
      );
    });

    const proof = await source.archiveFinalizeSource(fence, aggregateHash, manifestR2Key);
    expect(proof).toMatchObject({ state: 'source_deleted', migrationId: fence.migrationId });
    expect(proof.sourceDatabaseSizeAfter).toBeLessThanOrEqual(proof.sourceDatabaseSizeBefore!);
    // Simulate the cross-store crash gap: source deletion committed while D1
    // still says sealed. Expire the old lease and let the external coordinator
    // recover from the source-local source_deleted proof.
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
       SET lease_expires_at = 0 WHERE migration_id = ? AND state = 'sealed'`
    )
      .bind(fence.migrationId)
      .run();
    const recoveryEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      const sweep = await runProjectDataArchiveShardingSweep(recoveryEnv, Date.now());
      expect(sweep).toMatchObject({ failed: 0, frozen: 0 });
      const recovery = await env.DATABASE.prepare(
        `SELECT state, recovery_verified_at FROM project_data_archive_migrations
         WHERE migration_id = ?`
      )
        .bind(fence.migrationId)
        .first<{ state: string; recovery_verified_at: number | null }>();
      if (recovery?.state === 'sealed' && recovery.recovery_verified_at !== null) break;
      if (attempt === 19) throw new Error('recovery evidence did not verify within bounded sweeps');
    }
    await expect(
      runProjectDataArchiveShardingSweep(recoveryEnv, Date.now())
    ).resolves.toMatchObject({ archived: 0, failed: 0, frozen: 0 });
    await expect(
      env.DATABASE.prepare(
        `SELECT state, source_deleted_at FROM project_data_archive_migrations
         WHERE migration_id = ?`
      )
        .bind(fence.migrationId)
        .first()
    ).resolves.toMatchObject({ state: 'source_deleted', source_deleted_at: expect.any(Number) });
    await expect(
      runProjectDataArchiveShardingSweep(recoveryEnv, Date.now())
    ).resolves.toMatchObject({ archived: 1, failed: 0, frozen: 0 });

    await runInDurableObject(target, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_data_archive_targets SET state = 'sealed'
         WHERE migration_id = ? AND state = 'authoritative'`,
        fence.migrationId
      );
    });
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations SET target_authoritative_at = NULL
       WHERE migration_id = ? AND state = 'archived'`
    )
      .bind(fence.migrationId)
      .run();
    await expect(
      service.searchMessages(testEnv, projectId, 'terminal transcript', null, null, 20)
    ).rejects.toThrow('ambiguous routing state');
    await expect(
      service.getArchivedToolPayloads(testEnv, projectId, { startTime: 0, limit: 10 })
    ).rejects.toThrow('ambiguous routing state');
    await expect(
      runProjectDataArchiveShardingSweep(recoveryEnv, Date.now())
    ).resolves.toMatchObject({ failed: 0, frozen: 0 });
    await expect(
      env.DATABASE.prepare(
        `SELECT target_authoritative_at FROM project_data_archive_migrations
         WHERE migration_id = ?`
      )
        .bind(fence.migrationId)
        .first()
    ).resolves.toMatchObject({ target_authoritative_at: expect.any(Number) });

    const routed = await service.getMessages(
      testEnv,
      projectId,
      sessionId,
      20,
      null,
      null,
      undefined,
      false,
      'asc'
    );
    expect(routed.messages.map((message) => message.id)).toEqual(messageIds);
    expect(await service.getMessageCount(testEnv, projectId, sessionId)).toBe(6);
    await expect(
      service.getMessageToolContent(testEnv, projectId, sessionId, messageIds[0]!)
    ).resolves.toMatchObject({ source: 'archive', content: archivedToolContent });
    await expect(
      service.getArchivedToolPayloads(testEnv, projectId, { sessionId, limit: 10 })
    ).resolves.toMatchObject({
      payloads: [expect.objectContaining({ messageId: messageIds[0], available: true })],
    });
    await expect(
      service.getLatestPersistedPlan(testEnv, projectId, sessionId)
    ).resolves.toMatchObject({ currentPlan: [{ step: 'archive safely', status: 'completed' }] });
    await expect(
      service.getArchivedToolPayloads(testEnv, projectId, { startTime: 0, limit: 10 })
    ).resolves.toMatchObject({
      partial: false,
      ownersQueried: 2,
      partialReason: null,
    });
    await expect(
      service.searchMessages(testEnv, projectId, 'terminal transcript', null, null, 20)
    ).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ sessionId })]),
      partial: false,
      ownersQueried: 2,
    });
    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations
       SET owner_name = 'project-data-archive:another-project:0'
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, sessionId)
      .run();
    await expect(
      service.searchMessages(testEnv, projectId, 'terminal transcript', null, null, 20)
    ).rejects.toThrow(/ambiguous routing state|invalid archive owner identity/);
    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations SET owner_name = ?
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(targetOwner, projectId, sessionId)
      .run();
    const partialOwnerName = `project-data-archive:${projectId}:2`;
    const partialOwner = stub(partialOwnerName);
    await partialOwner.ensureProjectId(projectId);
    const partialSessionId = await partialOwner.createSession(null, 'Partial owner');
    await partialOwner.persistMessage(partialSessionId, 'user', 'owner-cap-only', null);
    await partialOwner.stopSession(partialSessionId);
    const partialMigrationId = crypto.randomUUID();
    await runInDurableObject(partialOwner, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_targets
         (session_id, project_id, migration_id, owner_name, generation, state,
          terminal_version, lease_token, lease_epoch, lease_expires_at,
          aggregate_hash, manifest_r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'authoritative', 'partial-version', 'partial-token',
                 1, ?, 'partial-hash', 'partial-manifest', ?, ?)`,
        partialSessionId,
        projectId,
        partialMigrationId,
        partialOwnerName,
        Date.now() + 60_000,
        Date.now(),
        Date.now()
      );
    });
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name, source_generation,
          target_owner_name, target_generation, terminal_version, aggregate_hash,
          manifest_r2_key, source_deleted_at, archived_at, target_authoritative_at,
          created_at, updated_at)
         VALUES (?, ?, ?, 'archived', ?, 0, ?, 1, 'partial-version', 'partial-hash',
                 'partial-manifest', ?, ?, ?, ?, ?)`
      ).bind(
        partialMigrationId,
        projectId,
        partialSessionId,
        projectId,
        partialOwnerName,
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now(),
        Date.now()
      ),
      env.DATABASE.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES (?, ?, 'archive_shard', 'archive_shard', ?, 1, ?, 1, ?)`
      ).bind(projectId, partialSessionId, partialOwnerName, partialMigrationId, Date.now()),
    ]);
    const cappedReadEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '1',
    };
    await expect(
      service.searchMessages(cappedReadEnv, projectId, 'terminal transcript', null, null, 20)
    ).resolves.toMatchObject({
      partial: true,
      ownersQueried: 2,
      reason: 'archive_owner_limit_reached',
    });
    await expect(
      service.getArchivedToolPayloads(cappedReadEnv, projectId, { startTime: 0, limit: 10 })
    ).resolves.toMatchObject({
      partial: true,
      ownersQueried: 2,
      partialReason: 'archive_owner_limit_reached',
    });
    const packedNeighbor = await target.createSession(null, 'Packed neighbor');
    await target.persistMessage(packedNeighbor, 'user', 'packed-neighbor-only', null);
    await target.stopSession(packedNeighbor);
    await runInDurableObject(target, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO project_data_archive_targets
         (session_id, project_id, migration_id, owner_name, generation, state,
          terminal_version, lease_token, lease_epoch, lease_expires_at,
          aggregate_hash, manifest_r2_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'authoritative', ?, 'neighbor-token', 1, ?, ?, ?, ?, ?)`,
        packedNeighbor,
        projectId,
        `neighbor-${fence.migrationId}`,
        targetOwner,
        'neighbor-version',
        Date.now() + 60_000,
        'neighbor-hash',
        'neighbor-manifest',
        Date.now(),
        Date.now()
      );
    });
    await expect(
      service.searchMessages(testEnv, projectId, 'packed-neighbor-only', sessionId, null, 10)
    ).resolves.toMatchObject({ results: [], partial: false, ownersQueried: 1 });
    const rootAnchor = await source.getSession(sessionId);
    expect(rootAnchor).toMatchObject({ id: sessionId, messageCount: 6, status: 'stopped' });
    expect(rootAnchor?.lastMessageAt).toBeTypeOf('number');

    const sourceRead = await captureProjectDataExpectedError(source, {
      operation: 'getMessages',
      args: [sessionId],
    });
    expect(sourceRead).toMatchObject({ threw: true });
    expect(sourceRead.message).toContain('source_deleted');
    const sourceCountRead = await captureProjectDataExpectedError(source, {
      operation: 'getMessageCount',
      args: [sessionId],
    });
    expect(sourceCountRead).toMatchObject({ threw: true });
    expect(sourceCountRead.message).toContain('source_deleted');
    const sourceToolRead = await captureProjectDataExpectedError(source, {
      operation: 'getMessageToolContent',
      args: [sessionId, messageIds[0]],
    });
    expect(sourceToolRead).toMatchObject({ threw: true });
    expect(sourceToolRead.message).toContain('source_deleted');
    const sourceToolList = await captureProjectDataExpectedError(source, {
      operation: 'getArchivedToolPayloads',
      args: [{ sessionId, startTime: 0, limit: 10 }],
    });
    expect(sourceToolList).toMatchObject({ threw: true });
    expect(sourceToolList.message).toContain('source_deleted');
    const sourceExactSearch = await captureProjectDataExpectedError(source, {
      operation: 'searchMessages',
      args: ['terminal transcript', sessionId, null, 20],
    });
    expect(sourceExactSearch).toMatchObject({ threw: true });
    expect(sourceExactSearch.message).toContain('source_deleted');
    const sourcePlanRead = await captureProjectDataExpectedError(source, {
      operation: 'getLatestPersistedPlan',
      args: [sessionId],
    });
    expect(sourcePlanRead).toMatchObject({ threw: true });
    expect(sourcePlanRead.message).toContain('source_deleted');
    const lateDelivery = {
      deliveryId: `late-${fence.migrationId}`,
      targetSessionId: sessionId,
      displayContent: 'must not split transcript ownership',
      deliveryContent: 'must not split transcript ownership',
      senderType: 'human' as const,
      senderId: 'user',
      messageClass: 'deliver' as const,
      sourceKind: 'user_followup' as const,
    };
    await expect(service.acceptPromptDelivery(testEnv, projectId, lateDelivery)).rejects.toThrow(
      /archived|migration is in progress/i
    );
    const directLateDelivery = await captureProjectDataExpectedError(source, {
      operation: 'acceptPromptDelivery',
      args: [lateDelivery],
    });
    expect(directLateDelivery).toMatchObject({ threw: true });
    expect(directLateDelivery.message).toMatch(/archived|source_deleted/i);
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `UPDATE tasks SET status = 'in_progress', chat_session_id = ? WHERE id = ?`
      ).bind(sessionId, waitParentTaskId),
      env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).bind(
        waitChildTaskId
      ),
    ]);
    const waitReconciliation = await source.reconcileTaskWaits(waitChildTaskId);
    expect(waitReconciliation).toMatchObject({ checked: 1, resolved: 0, failed: 1 });
    await env.DATABASE.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`)
      .bind(waitParentTaskId)
      .run();
    await expect(service.getMessageCount(testEnv, projectId, sessionId)).resolves.toBe(6);
    await expect(source.getDurableExecutionSnapshot(sessionId)).resolves.toMatchObject({
      deliveries: [],
    });
    expect(
      (await source.searchMessages('terminal transcript', null, null, 20)).some(
        (message) => message.sessionId === sessionId
      )
    ).toBe(false);
    const comment = await captureProjectDataExpectedError(source, {
      operation: 'createCommentThread',
      args: [
        {
          sessionId,
          messageId: messageIds[0]!,
          body: 'late comment',
          actor: { kind: 'human', id: 'user', name: 'User' },
        },
      ],
    });
    expect(comment).toMatchObject({ threw: true });
    expect(comment.message).toMatch(/archive source|terminal archive placement/);

    const cleanOwner = `project-data-archive:${projectId}:1`;
    const rootDatabaseSize = await service.getArchiveOwnerDatabaseSize(
      testEnv,
      projectId,
      projectId
    );
    const cleanDatabaseSize = await service.getArchiveOwnerDatabaseSize(
      testEnv,
      projectId,
      cleanOwner
    );
    const sessionCanonicalBytes = await service.getArchiveTargetCanonicalBytes(testEnv, {
      projectId,
      sessionId,
      migrationId: fence.migrationId,
      ownerName: targetOwner,
      generation: 1,
    });
    expect(rootDatabaseSize).toBeGreaterThan(cleanDatabaseSize);
    const fallbackStorageLimit = Math.ceil(
      (cleanDatabaseSize + sessionCanonicalBytes * 2 + 1) / 0.99
    );
    expect(Math.floor(fallbackStorageLimit * 0.99)).toBeLessThan(
      rootDatabaseSize + sessionCanonicalBytes * 2
    );
    await expect(
      requestProjectDataArchiveRehome(
        {
          ...testEnv,
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO: '0.99',
          PROJECT_DATA_STORAGE_LIMIT_BYTES: String(fallbackStorageLimit),
        },
        projectId,
        sessionId,
        projectId
      )
    ).rejects.toThrow(/requires an explicit fallback target/);
    const rehome = await requestProjectDataArchiveRehome(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO: '0.99',
        PROJECT_DATA_STORAGE_LIMIT_BYTES: String(fallbackStorageLimit),
      },
      projectId,
      sessionId,
      projectId,
      cleanOwner
    );
    expect(rehome).toMatchObject({
      sourceOwnerName: targetOwner,
      sourceGeneration: 1,
      targetOwnerName: cleanOwner,
      targetGeneration: 2,
      rootCopybackRequested: true,
      rootCopybackAccepted: false,
    });
    await expect(service.getMessages(testEnv, projectId, sessionId)).rejects.toThrow(
      /migration is in progress/
    );
    await runUntilOneArchive(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      },
      40
    );
    await expect(service.getMessageCount(testEnv, projectId, sessionId)).resolves.toBe(6);
    const oldOwnerRead = await captureProjectDataExpectedError(target, {
      operation: 'archiveGetMessages',
      args: [
        {
          projectId,
          sessionId,
          migrationId: fence.migrationId,
          ownerName: targetOwner,
          generation: 1,
        },
      ],
    });
    expect(oldOwnerRead).toMatchObject({ threw: true });
    expect(oldOwnerRead.message).toMatch(/rehome source|owner\/generation mismatch/);

    const copyback = await requestProjectDataArchiveRehome(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_ROOT_COPY_MAX_RATIO: '0.99',
      },
      projectId,
      sessionId,
      projectId,
      targetOwner
    );
    expect(copyback).toMatchObject({
      sourceGeneration: 2,
      targetOwnerName: projectId,
      targetGeneration: 0,
      rootCopybackRequested: true,
      rootCopybackAccepted: true,
    });
    await runUntilOneArchive(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      },
      40
    );
    await expect(service.getMessages(testEnv, projectId, sessionId, 20)).resolves.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ id: messageIds[0] })]),
    });
    await expect(source.getMessageCount(sessionId)).resolves.toBe(6);
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations SET target_cleanup_at = NULL
       WHERE migration_id = ? AND state = 'archived'
         AND target_generation = 0 AND target_authoritative_at IS NOT NULL`
    )
      .bind(fence.migrationId)
      .run();
    await expect(
      service.searchMessages(testEnv, projectId, 'terminal transcript', null, null, 20)
    ).rejects.toThrow(/ambiguous routing state/);
    await expect(
      runProjectDataArchiveShardingSweep(
        {
          ...testEnv,
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        },
        Date.now()
      )
    ).resolves.toMatchObject({ failed: 0, frozen: 0 });
    await expect(
      env.DATABASE.prepare(
        `SELECT target_cleanup_at FROM project_data_archive_migrations WHERE migration_id = ?`
      )
        .bind(fence.migrationId)
        .first()
    ).resolves.toMatchObject({ target_cleanup_at: expect.any(Number) });
    await expect(
      service.searchMessages(testEnv, projectId, 'terminal transcript', null, null, 20)
    ).resolves.toMatchObject({
      results: expect.arrayContaining([expect.objectContaining({ sessionId })]),
      partial: false,
    });
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE chat_messages SET content = 'poisoned-root-copyback'
         WHERE id = ?`,
        messageIds[0]!
      );
    });
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
       SET state = 'frozen', target_authoritative_at = NULL,
           last_error = 'test root copyback target loss'
       WHERE migration_id = ? AND state = 'archived'`
    )
      .bind(fence.migrationId)
      .run();
    const copybackEvidence = await env.DATABASE.prepare(
      `SELECT manifest_r2_key FROM project_data_archive_migrations WHERE migration_id = ?`
    )
      .bind(fence.migrationId)
      .first<{ manifest_r2_key: string }>();
    if (!copybackEvidence?.manifest_r2_key) throw new Error('copyback evidence is missing');
    const encodedProjectId = encodeURIComponent(projectId);
    const sameLengthForeignKey = copybackEvidence.manifest_r2_key.replace(
      `${DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX}/${encodedProjectId}/`,
      `${DEFAULT_PROJECT_DATA_ARCHIVE_R2_PREFIX}/${'x'.repeat(encodedProjectId.length)}/`
    );
    expect(sameLengthForeignKey).not.toBe(copybackEvidence.manifest_r2_key);
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations SET manifest_r2_key = ? WHERE migration_id = ?`
    )
      .bind(sameLengthForeignKey, fence.migrationId)
      .run();
    await expect(
      requestProjectDataArchiveForwardFix(
        {
          ...testEnv,
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        },
        fence.migrationId,
        'restore_target'
      )
    ).rejects.toThrow(/outside its migration prefix/);
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations SET manifest_r2_key = ? WHERE migration_id = ?`
    )
      .bind(copybackEvidence.manifest_r2_key, fence.migrationId)
      .run();
    await requestProjectDataArchiveForwardFix(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      },
      fence.migrationId,
      'restore_target'
    );
    await expect(service.getMessageCount(testEnv, projectId, sessionId)).rejects.toThrow(
      /migration is in progress/
    );
    await runUntilOneArchive(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      },
      40
    );
    await expect(service.getMessages(testEnv, projectId, sessionId, 20)).resolves.toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({ id: messageIds[0], content: expect.stringContaining('0-') }),
      ]),
    });
  });

  it('migrates a logical transcript larger than 32 MiB through idempotent bounded chunks', async () => {
    const projectId = `large-archive-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Large archive');
    const content = 'x'.repeat(1_100_000);
    await runInDurableObject(source, async (_instance, state) => {
      for (let index = 0; index < 34; index++) {
        state.storage.sql.exec(
          `INSERT INTO chat_messages
           (id, session_id, role, content, tool_metadata, created_at, sequence, origin)
           VALUES (?, ?, 'user', ?, NULL, ?, ?, 'user')`,
          `large-${String(index).padStart(3, '0')}`,
          sessionId,
          content,
          index + 1,
          index + 1
        );
      }
      state.storage.sql.exec(
        `UPDATE chat_sessions SET status = 'stopped', message_count = 34,
         ended_at = 0, updated_at = 0 WHERE id = ?`,
        sessionId
      );
    });
    const eligibility = await source.archiveInspectSourceEligibility(
      projectId,
      sessionId,
      Date.now(),
      1
    );
    expect(eligibility).toMatchObject({ eligible: true });
    await source.runSummarySyncForTest();
    const belowCandidateBudget = await runProjectDataArchiveShardingSweep(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS: '11',
      },
      Date.now()
    );
    expect(belowCandidateBudget).toMatchObject({
      selected: 0,
      progressed: 0,
      failed: 0,
      frozen: 0,
    });
    const budgetYield = await runProjectDataArchiveShardingSweep(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS: '1',
        PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS: '20',
      },
      Date.now()
    );
    expect(budgetYield).toMatchObject({ selected: 1, progressed: 1, failed: 0, frozen: 0 });
    const budgetJournal = await env.DATABASE.prepare(
      `SELECT state, next_chunk_index, target_owner_name
       FROM project_data_archive_migrations WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, sessionId)
      .first<{ state: string; next_chunk_index: number; target_owner_name: string }>();
    expect(budgetJournal).toMatchObject({ state: 'copying', next_chunk_index: 0 });
    const budgetTarget = stub(budgetJournal!.target_owner_name);
    await runInDurableObject(budgetTarget, async (_instance, state) => {
      expect(
        state.storage.sql.exec('SELECT COUNT(*) AS cnt FROM project_data_archive_chunks').one().cnt
      ).toBe(0);
    });
    const firstSweep = await runProjectDataArchiveShardingSweep(
      {
        ...testEnv,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '1',
        PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS: '1',
        PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS: '1',
      },
      Date.now()
    );
    expect(firstSweep).toMatchObject({ selected: 1, progressed: 1, failed: 0, frozen: 0 });
    await expect(
      env.DATABASE.prepare(
        `SELECT state, next_chunk_index FROM project_data_archive_migrations
         WHERE project_id = ? AND session_id = ?`
      )
        .bind(projectId, sessionId)
        .first()
    ).resolves.toMatchObject({ state: 'copying', next_chunk_index: 1 });
    const coordinatorEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
      PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS: '1',
      PROJECT_DATA_ARCHIVE_CHUNK_MAX_BYTES: String(8 * 1024 * 1024),
      PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS: '1',
    };
    let sealedJournal: {
      migration_id: string;
      state: string;
      recovery_verify_page_key: string | null;
      recovery_verify_entry_index: number;
      manifest_r2_key: string;
    } | null = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      const sweep = await runProjectDataArchiveShardingSweep(coordinatorEnv, Date.now());
      expect(sweep).toMatchObject({ failed: 0, frozen: 0 });
      sealedJournal = await env.DATABASE.prepare(
        `SELECT migration_id, state, recovery_verify_page_key,
                recovery_verify_entry_index, manifest_r2_key
         FROM project_data_archive_migrations WHERE project_id = ? AND session_id = ?`
      )
        .bind(projectId, sessionId)
        .first<{
          migration_id: string;
          state: string;
          recovery_verify_page_key: string | null;
          recovery_verify_entry_index: number;
          manifest_r2_key: string;
        }>();
      if (sealedJournal?.state === 'sealed' && sealedJournal.recovery_verify_page_key) break;
    }
    if (!sealedJournal?.recovery_verify_page_key) {
      throw new Error('large transcript did not reach bounded recovery verification');
    }
    const verificationPage = await env.PROJECT_DATA_ARCHIVE_R2.get(
      sealedJournal.recovery_verify_page_key
    );
    if (!verificationPage) throw new Error('large transcript verification page is missing');
    const verificationPageBody = new Uint8Array(await verificationPage.arrayBuffer());
    const verificationPageJson = JSON.parse(new TextDecoder().decode(verificationPageBody)) as {
      entries: Array<{ r2Key: string }>;
    };
    const missingEntry = verificationPageJson.entries[sealedJournal.recovery_verify_entry_index];
    if (!missingEntry) throw new Error('large transcript verification entry is missing');
    const missingObject = await env.PROJECT_DATA_ARCHIVE_R2.get(missingEntry.r2Key);
    if (!missingObject) throw new Error('large transcript recovery chunk is missing');
    const missingBody = new Uint8Array(await missingObject.arrayBuffer());
    const missingMetadata = missingObject.customMetadata;
    await env.PROJECT_DATA_ARCHIVE_R2.delete(missingEntry.r2Key);
    await expect(
      runProjectDataArchiveShardingSweep(coordinatorEnv, Date.now())
    ).resolves.toMatchObject({ frozen: 1, archived: 0 });
    const operatorAlert = await env.OBSERVABILITY_DATABASE.prepare(
      `SELECT COUNT(*) AS count FROM platform_errors
       WHERE message = 'ProjectData terminal archive migration frozen'`
    ).first<{ count: number }>();
    expect(operatorAlert?.count).toBeGreaterThan(0);
    await env.PROJECT_DATA_ARCHIVE_R2.put(missingEntry.r2Key, missingBody, {
      customMetadata: missingMetadata,
    });
    await requestProjectDataArchiveForwardFix(coordinatorEnv, sealedJournal.migration_id, 'retry');
    await runUntilOneArchive(coordinatorEnv, 100);
    const journal = await env.DATABASE.prepare(
      `SELECT migration_id, aggregate_hash, manifest_r2_key
       FROM project_data_archive_migrations
       WHERE project_id = ? AND session_id = ? AND state = 'archived'`
    )
      .bind(projectId, sessionId)
      .first<{ migration_id: string; aggregate_hash: string; manifest_r2_key: string }>();
    if (!journal) throw new Error('large transcript archive journal is missing');
    const proof = await source.archiveInspectSourceProof(projectId, sessionId);
    expect(proof).toMatchObject({ state: 'source_deleted' });
    expect(proof.sourceDatabaseSizeAfter).toBeLessThan(proof.sourceDatabaseSizeBefore!);
    await expect(service.getMessageCount(testEnv, projectId, sessionId)).resolves.toBe(34);
    const recoveryPrefix = `project-data/archive-sharding/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(journal.migration_id)}/`;
    const recoveryObjects = await env.PROJECT_DATA_ARCHIVE_R2.list({
      prefix: recoveryPrefix,
    });
    const chunkObjects = recoveryObjects.objects.filter((object) =>
      /\/(chat_messages|chat_messages_grouped|tool_payload_archives)\//.test(object.key)
    );
    const manifestPages = recoveryObjects.objects.filter((object) =>
      object.key.includes('/manifest-page-')
    );
    expect(chunkObjects.length).toBeGreaterThan(32);
    expect(manifestPages.length).toBeGreaterThan(1);
    expect(recoveryObjects.objects.every((object) => object.size < 32 * 1024 * 1024)).toBe(true);
    await runInDurableObject(source, async (_instance, state) => {
      const remaining = state.storage.sql
        .exec('SELECT COUNT(*) AS cnt FROM chat_messages WHERE session_id = ?', sessionId)
        .toArray()[0]?.cnt;
      expect(remaining).toBe(0);
      expect(
        state.storage.sql.exec('SELECT COUNT(*) AS cnt FROM chat_messages_grouped_fts').one().cnt
      ).toBe(0);
    });
  });

  it('enforces every terminal eligibility dependency before intent', async () => {
    const projectId = `eligibility-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const active = await source.createSession(null, 'Active');
    await expect(
      source.archiveInspectSourceEligibility(projectId, active, Date.now(), 1_000)
    ).resolves.toMatchObject({ eligible: false, reason: 'session_not_terminal' });

    const terminal = await source.createSession(null, 'Young');
    const messageId = await source.persistMessage(terminal, 'user', 'hello', null);
    await source.stopSession(terminal);
    await expect(
      source.archiveInspectSourceEligibility(projectId, terminal, Date.now(), 60_000)
    ).resolves.toMatchObject({ eligible: false, reason: 'terminal_grace_not_elapsed' });
    await source.createCommentThread({
      sessionId: terminal,
      messageId,
      body: 'preserve me',
      actor: { kind: 'human', id: 'user', name: 'User' },
    });
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec('UPDATE chat_sessions SET ended_at = 0 WHERE id = ?', terminal);
    });
    await expect(
      source.archiveInspectSourceEligibility(projectId, terminal, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'message_comments_present' });

    const malformed = await source.createSession(null, 'Malformed metadata');
    await source.persistMessage(malformed, 'assistant', 'tool', '{invalid json');
    await source.stopSession(malformed);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec('UPDATE chat_sessions SET ended_at = 0 WHERE id = ?', malformed);
    });
    await expect(
      source.archiveInspectSourceEligibility(projectId, malformed, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'invalid_tool_metadata' });

    const inline = await source.createSession(null, 'Inline payload');
    await source.persistMessage(inline, 'assistant', 'tool', JSON.stringify({ content: 'secret' }));
    await source.stopSession(inline);
    const cleanup = await source.createSession(null, 'Cleanup pending');
    const cleanupMessage = await source.persistMessage(cleanup, 'assistant', 'tool', null);
    await source.stopSession(cleanup);
    const snapshot = await source.createSession(null, 'Restorable');
    await source.persistMessage(snapshot, 'user', 'snapshot', null);
    await source.stopSession(snapshot);
    const live = await source.createSession(null, 'Live task');
    await source.persistMessage(live, 'user', 'task', null);
    await source.stopSession(live);
    const draft = await source.createSession(null, 'Draft task');
    await source.persistMessage(draft, 'user', 'draft task', null);
    await source.stopSession(draft);
    const ready = await source.createSession(null, 'Ready task');
    await source.persistMessage(ready, 'user', 'ready task', null);
    await source.stopSession(ready);
    const failed = await source.createSession(null, 'Failed terminal');
    await source.persistMessage(failed, 'user', 'failed', null);
    await source.stopSession(failed);
    await runInDurableObject(source, async (_instance, state) => {
      for (const id of [inline, cleanup, snapshot, live, draft, ready, failed]) {
        state.storage.sql.exec(
          'UPDATE chat_sessions SET ended_at = 0, updated_at = 0 WHERE id = ?',
          id
        );
      }
      state.storage.sql.exec("UPDATE chat_sessions SET status = 'failed' WHERE id = ?", failed);
      state.storage.sql.exec(
        `INSERT INTO tool_payload_cleanup_attempts
         (message_id, status, failure_count, last_attempt_at, message_created_at, message_sequence)
         VALUES (?, 'pending', 0, 1, 1, 1)`,
        cleanupMessage
      );
    });
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
       (id, project_id, user_id, chat_session_id, runtime, status, degradation,
        manifest_r2_key, expires_at, sleep_status, sleeping_at, recovery_attempts, updated_at)
       VALUES (?, ?, ?, ?, 'vm', 'available', 'none', ?, ?, 'sleeping', ?, 0, ?)`
    )
      .bind(
        `snapshot-${snapshot}`,
        projectId,
        `user-${projectId}`,
        snapshot,
        `snapshots/${snapshot}/manifest.json`,
        new Date(Date.now() + 60_000).toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      )
      .run();
    await seedTask(`task-${live}`, projectId, `user-${projectId}`, {
      status: 'in_progress',
      chatSessionId: live,
    });
    await seedTask(`task-${draft}`, projectId, `user-${projectId}`, {
      status: 'draft',
      chatSessionId: draft,
    });
    await seedTask(`task-${ready}`, projectId, `user-${projectId}`, {
      status: 'ready',
      chatSessionId: ready,
    });
    await expect(
      source.archiveInspectSourceEligibility(projectId, inline, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'inline_tool_payload_present' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, cleanup, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'tool_cleanup_incomplete' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, snapshot, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'restorable_snapshot_present' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, live, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'live_task_present' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, draft, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'live_task_present' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, ready, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: false, reason: 'live_task_present' });
    await expect(
      source.archiveInspectSourceEligibility(projectId, failed, Date.now(), 1)
    ).resolves.toMatchObject({ eligible: true, reason: null });
  });

  it('fences wake authorization and rejects a stale source lease epoch', async () => {
    const projectId = `fence-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Fence');
    await source.persistMessage(sessionId, 'user', 'hello', null);
    await source.stopSession(sessionId);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET ended_at = 0, updated_at = 0 WHERE id = ?',
        sessionId
      );
    });
    const eligibility = await source.archiveInspectSourceEligibility(
      projectId,
      sessionId,
      Date.now(),
      1
    );
    expect(await isProjectDataSessionWakeAllowed(env.DATABASE, projectId, sessionId)).toBe(true);
    await env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations
       (project_id, session_id, state, owner_kind, owner_name, generation,
        migration_id, routing_version, updated_at)
       VALUES (?, ?, 'root', 'root', 'wrong-owner', 0, NULL, 1, ?)`
    )
      .bind(projectId, sessionId, Date.now())
      .run();
    expect(await isProjectDataSessionWakeAllowed(env.DATABASE, projectId, sessionId)).toBe(false);
    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations SET owner_name = ?, routing_version = 99
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(projectId, projectId, sessionId)
      .run();
    expect(await isProjectDataSessionWakeAllowed(env.DATABASE, projectId, sessionId)).toBe(false);
    await env.DATABASE.prepare(
      'DELETE FROM project_data_session_locations WHERE project_id = ? AND session_id = ?'
    )
      .bind(projectId, sessionId)
      .run();
    const first = await planMigration(
      projectId,
      sessionId,
      eligibility.terminalVersion!,
      `project-data-archive:${projectId}:0`
    );
    await source.archiveEstablishSourceIntent(first);
    const reclaimed = {
      ...first,
      leaseToken: crypto.randomUUID(),
      leaseEpoch: 2,
      leaseExpiresAt: Date.now() + 60_000,
    };
    await source.archiveEstablishSourceIntent(reclaimed);
    const stale = await runInDurableObject(source, async (instance) => {
      try {
        await instance.archiveReadSourceChunk(first, 'chat_messages', 0, null, 10, 1024 * 1024);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(stale).toMatch(/fence mismatch|lease expired or changed/);
    expect(await isProjectDataSessionWakeAllowed(env.DATABASE, projectId, sessionId)).toBe(false);
  });

  it('defers a poison candidate so a later terminal session can progress', async () => {
    const projectId = `poison-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const poisonSession = await source.createSession(null, 'Poison');
    await source.persistMessage(poisonSession, 'assistant', 'tool', '{invalid json');
    await source.stopSession(poisonSession);
    const healthySession = await source.createSession(null, 'Healthy');
    await source.persistMessage(healthySession, 'user', 'healthy transcript', null);
    await source.stopSession(healthySession);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET ended_at = 0, updated_at = 0 WHERE id = ?',
        poisonSession
      );
      state.storage.sql.exec(
        'UPDATE chat_sessions SET ended_at = 1, updated_at = 1 WHERE id = ?',
        healthySession
      );
    });
    await source.runSummarySyncForTest();
    const coordinatorEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
      PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS: '1',
    };

    await expect(
      runProjectDataArchiveShardingSweep(coordinatorEnv, Date.now())
    ).resolves.toMatchObject({ enabled: true, selected: 0, archived: 0 });
    await expect(
      env.DATABASE.prepare(
        `SELECT reason, poisoned FROM project_data_archive_candidate_deferrals
         WHERE project_id = ? AND session_id = ?`
      )
        .bind(projectId, poisonSession)
        .first()
    ).resolves.toMatchObject({ reason: 'invalid_tool_metadata', poisoned: 1 });

    await runUntilOneArchive(coordinatorEnv);
    await expect(service.getMessageCount(testEnv, projectId, healthySession)).resolves.toBe(1);

    const healthyJournal = await env.DATABASE.prepare(
      `SELECT migration_id, target_owner_name FROM project_data_archive_migrations
       WHERE project_id = ? AND session_id = ? AND state = 'archived'`
    )
      .bind(projectId, healthySession)
      .first<{ migration_id: string; target_owner_name: string }>();
    if (!healthyJournal) throw new Error('healthy archive journal is missing');
    const healthyTarget = stub(healthyJournal.target_owner_name);
    await runInDurableObject(healthyTarget, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE project_data_archive_targets
         SET state = 'sealed', aggregate_hash = 'poisoned-existing-target'
         WHERE session_id = ?`,
        healthySession
      );
      state.storage.sql.exec(
        `UPDATE chat_messages SET content = 'poisoned-existing-target' WHERE session_id = ?`,
        healthySession
      );
    });
    await env.DATABASE.prepare(
      `UPDATE project_data_archive_migrations
       SET state = 'frozen', target_authoritative_at = NULL, last_error = 'test target loss'
       WHERE migration_id = ? AND state = 'archived'`
    )
      .bind(healthyJournal.migration_id)
      .run();
    await requestProjectDataArchiveForwardFix(
      coordinatorEnv,
      healthyJournal.migration_id,
      'restore_target'
    );
    await expect(service.getMessageCount(testEnv, projectId, healthySession)).rejects.toThrow(
      /migration is in progress/
    );
    await runUntilOneArchive(coordinatorEnv);
    await expect(service.getMessageCount(testEnv, projectId, healthySession)).resolves.toBe(1);
  });

  it('freezes a poisoned published target without blocking later coordinator work', async () => {
    const projectId = `published-poison-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = stub(projectId);
    await source.ensureProjectId(projectId);
    const healthySession = await source.createSession(null, 'Healthy after poison');
    await source.persistMessage(healthySession, 'user', 'healthy after poison', null);
    await source.stopSession(healthySession);
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE chat_sessions SET ended_at = 0, updated_at = 0 WHERE id = ?',
        healthySession
      );
    });
    await source.runSummarySyncForTest();
    const poisonedMigration = crypto.randomUUID();
    const poisonedSession = crypto.randomUUID();
    const poisonedOwner = `project-data-archive:${projectId}:15`;
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name, source_generation,
          target_owner_name, target_generation, terminal_version, aggregate_hash,
          manifest_r2_key, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, 'archived', ?, 0, ?, 1, 'poison-version', 'poison-hash',
                 'missing-manifest', 1, 1, 1)`
      ).bind(poisonedMigration, projectId, poisonedSession, projectId, poisonedOwner),
      env.DATABASE.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES (?, ?, 'archive_shard', 'archive_shard', ?, 1, ?, 1, 1)`
      ).bind(projectId, poisonedSession, poisonedOwner, poisonedMigration),
    ]);
    const coordinatorEnv = {
      ...testEnv,
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '1',
      PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '8',
      PROJECT_DATA_ARCHIVE_TERMINAL_GRACE_MS: '1',
    };

    const first = await runProjectDataArchiveShardingSweep(coordinatorEnv, Date.now());
    expect(first).toMatchObject({ selected: 1, failed: 0, frozen: 0 });
    await expect(
      env.DATABASE.prepare(
        'SELECT state, last_error FROM project_data_archive_migrations WHERE migration_id = ?'
      )
        .bind(poisonedMigration)
        .first()
    ).resolves.toMatchObject({ state: 'frozen' });
    await runUntilOneArchive(coordinatorEnv);
    await expect(service.getMessageCount(testEnv, projectId, healthySession)).resolves.toBe(1);
  });
});
