import { archiveShardProjectDataOwner } from '@simple-agent-manager/project-data/internal/client/project-data-archive-routing';
import {
  copyBackProjectDataArchiveMigration,
  runScopedProjectDataArchiveCanary,
} from '@simple-agent-manager/project-data/internal/scheduled/project-data-archive-sharding';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as service from '../../src/services/project-data';
import reporterMessages from './fixtures/archive-reporter-messages.json';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import {
  profileD1,
  profileObject,
  sumWrites,
  type WriteSample,
} from './helpers/archive-write-profile';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

async function runProfile(reset: boolean) {
  const projectId = `write-profile-${crypto.randomUUID()}`;
  await seedUser('write-profile-owner');
  await seedInstallation('write-profile-install', 'write-profile-owner');
  await seedProject(projectId, 'write-profile-owner', 'write-profile-install');
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  const sessionId = await source.createSession(null, 'Archive write profile');
  // 105 turns: user, 17 streamed assistant chunks, tool call, tool result.
  // Each chunk has its own ID, as the VM reporter emits it. Grouped materialization
  // combines the assistant run; archive must retain the original exact rows too.
  const seeded = reporterMessages.map((row) => ({
    ...row,
    toolMetadata: row.toolMetadata ?? null,
  }));
  for (let offset = 0; offset < seeded.length; offset += 50)
    await source.persistMessageBatch(sessionId, seeded.slice(offset, offset + 50));
  const toolKey = `write-profile-tool/${projectId}`;
  const archivedTool = JSON.parse(seeded[2099].toolMetadata!);
  await env.PROJECT_DATA_ARCHIVE_R2.put(
    toolKey,
    JSON.stringify({
      version: 1,
      projectId,
      sessionId,
      messageId: seeded[2099].messageId,
      messageCreatedAt: Date.parse(seeded[2099].timestamp),
      messageSequence: 2100,
      toolMetadata: archivedTool,
    })
  );
  await runInDurableObject(source, (_instance, state) => {
    // Model an already archived tool: inline body removed, exact R2 body retained.
    state.storage.sql.exec(
      'UPDATE chat_messages SET tool_metadata = ? WHERE id = ?',
      JSON.stringify({ title: 'Read file' }),
      seeded[2099].messageId
    );
    state.storage.sql.exec(
      `INSERT INTO tool_payload_archives
      (message_id, session_id, r2_key, content_bytes, tool_metadata_bytes, archived_at, message_created_at, message_sequence, archive_version)
      VALUES (?, ?, ?, 100, ?, ?, ?, 2100, 1)`,
      seeded[2099].messageId,
      sessionId,
      toolKey,
      JSON.stringify(archivedTool).length,
      Date.now(),
      Date.parse(seeded[2099].timestamp)
    );
  });
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  const shape = await runInDurableObject(source, (_instance, state) => ({
    raw: state.storage.sql
      .exec(
        'SELECT count(*) AS n, sum(length(CAST(content AS BLOB))) AS bytes FROM chat_messages WHERE session_id = ?',
        sessionId
      )
      .toArray()[0],
    grouped: state.storage.sql
      .exec('SELECT count(*) AS n FROM chat_messages_grouped WHERE session_id = ?', sessionId)
      .toArray()[0],
  }));
  await isolateSweepFixture(projectId);
  const original = await source.getMessages(sessionId, 2101, null, null, undefined, false, 'asc');
  const samples: WriteSample[] = [];
  const collectSource = await profileObject(source, 'source', samples);
  await withArchiveEnv(
    {
      PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
      PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
      PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '500',
    },
    async () => {
      const configured = env as unknown as Env;
      const owner = archiveShardProjectDataOwner(configured, projectId, sessionId, 1);
      const target = projectDataStub(owner.ownerName);
      await target.ensureProjectId(projectId);
      const collectTarget = await profileObject(target, 'target', samples);
      const measured = { ...configured, DATABASE: profileD1(env.DATABASE, samples) };
      let interrupted = false;
      const namespace = new Proxy(configured.PROJECT_DATA, {
        get(targetNamespace, key) {
          if (key === 'get')
            return (id: DurableObjectId) => {
              const stub = targetNamespace.get(id);
              return new Proxy(stub, {
                get(targetStub, method) {
                  if (method === 'then') return undefined;
                  if (method === 'archiveTargetCommitChunk')
                    return async (input: Parameters<typeof target.archiveTargetCommitChunk>[0]) => {
                      const result = await targetStub.archiveTargetCommitChunk(input);
                      if (
                        !interrupted &&
                        input.tableName === 'chat_messages' &&
                        input.ordinal === 1
                      ) {
                        interrupted = true;
                        throw new Error(
                          'injected reset after atomic target commit before coordinator checkpoint'
                        );
                      }
                      return result;
                    };
                  const value = Reflect.get(targetStub, method, targetStub);
                  return typeof value === 'function'
                    ? (...args: unknown[]) => Reflect.apply(value, targetStub, args)
                    : value;
                },
              });
            };
          const value = Reflect.get(targetNamespace, key, targetNamespace);
          return typeof value === 'function' ? value.bind(targetNamespace) : value;
        },
      });
      const args = {
        projectId,
        sessionId,
        dryRun: false,
        reason: 'full SQL write measurement',
        nowDate: new Date(Date.now() + 60_000),
      };
      if (reset) {
        const failed = await runScopedProjectDataArchiveCanary(
          { ...measured, PROJECT_DATA: namespace },
          args
        );
        expect(interrupted).toBe(true);
        expect(failed.stats).toMatchObject({ migrated: 0, failed: 1 });
        expect(await source.getMessageCount(sessionId)).toBe(seeded.length);
        expect((await readLocation(projectId, sessionId))?.location_state).not.toBe(
          'archive_shard'
        );
      }
      const result = await runScopedProjectDataArchiveCanary(measured, args);
      expect(result.stats).toMatchObject({ migrated: 1, failed: 0 });
      expect(await readLocation(projectId, sessionId)).toMatchObject({
        location_state: 'archive_shard',
      });
      collectSource();
      collectTarget();
      const statements: Record<string, { calls: number; rowsWritten: number }> = {};
      for (const sample of samples.filter((s) => s.rowsWritten)) {
        const key = `${sample.owner}:${sample.phase}:${sample.statement}`;
        const entry = (statements[key] ??= { calls: 0, rowsWritten: 0 });
        entry.calls++;
        entry.rowsWritten += sample.rowsWritten;
      }
      if (!reset) expect({ shape, phases: sumWrites(samples), statements }).toMatchSnapshot();
      // A lost response must replay the receipt without reinserting search documents.
      expect(
        samples
          .filter(
            (sample) =>
              sample.owner === 'target' &&
              sample.statement.startsWith(
                'INSERT OR IGNORE INTO project_data_archive_search_documents '
              )
          )
          .reduce((sum, sample) => sum + sample.rowsWritten, 0)
      ).toBe(966);
      const read = await service.getMessages(
        configured,
        projectId,
        sessionId,
        2_101,
        null,
        null,
        undefined,
        false,
        'asc'
      );
      expect(read.messages).toEqual(original.messages);
      const tool = await service.getMessageToolContent(
        configured,
        projectId,
        sessionId,
        seeded[2099].messageId
      );
      expect(tool).toMatchObject({ content: archivedTool.content, source: 'archive' });
      expect(
        read.messages.map((row) => ({ id: row.id, content: row.content, role: row.role }))
      ).toEqual(seeded.map((row) => ({ id: row.messageId, content: row.content, role: row.role })));
      const search = await service.searchMessagesWithArchiveMetadata(
        configured,
        projectId,
        'measurement',
        sessionId
      );
      expect(search.results.length).toBeGreaterThan(0);
      expect(await source.getMessageCount(sessionId)).toBe(0);
      const location = await readLocation(projectId, sessionId);
      if (!location?.migration_id) throw new Error('Missing migration');
      const restored = await copyBackProjectDataArchiveMigration(configured, {
        projectId,
        migrationId: location.migration_id,
        reason: 'profile exact copy-back proof',
      });
      expect(restored.restoredToRoot).toBe(true);
      expect(
        (
          await service.getMessages(
            configured,
            projectId,
            sessionId,
            2101,
            null,
            null,
            undefined,
            false,
            'asc'
          )
        ).messages
      ).toEqual(original.messages);
    }
  );
}

it(
  'profiles a full compact archive through the coordinator in real workerd',
  () => runProfile(false),
  120_000
);
it(
  'resumes after reset between atomic target commit and coordinator checkpoint',
  () => runProfile(true),
  120_000
);

it('proves the profile sees lazy SQL, DO-internal D1, KV and alarm writes', async () => {
  const source = projectDataStub(`profile-meter-${crypto.randomUUID()}`);
  await source.ensureProjectId('profile-meter');
  const samples: WriteSample[] = [];
  const collect = await profileObject(source, 'sentinel', samples);
  await runInDurableObject(source, async (instance) => {
    const holder = instance as unknown as {
      sql: SqlStorage;
      meteredStorage: DurableObjectStorage;
      env: { DATABASE: D1Database; KV: KVNamespace };
    };
    holder.sql
      .exec("INSERT INTO do_meta(key,value) VALUES('profile-sentinel','1') RETURNING key")
      .toArray();
    await holder.meteredStorage.put('profile-sentinel', '1');
    await holder.meteredStorage.delete('profile-sentinel');
    await holder.meteredStorage.setAlarm(Date.now() + 3_600_000);
    await holder.meteredStorage.deleteAlarm();
    await holder.env.KV.put('profile-sentinel', '1');
    await holder.env.KV.delete('profile-sentinel');
    await holder.env.DATABASE.prepare(
      "INSERT INTO project_data_archive_write_budget(id,window_started_at,reserved_writes) VALUES('global',0,0) ON CONFLICT(id) DO UPDATE SET reserved_writes=reserved_writes RETURNING id"
    ).all();
  });
  collect();
  for (const statement of [
    'storage.put',
    'storage.delete',
    'storage.setAlarm',
    'storage.deleteAlarm',
    'KV.put',
    'KV.delete',
  ])
    expect(samples.find((sample) => sample.statement === statement)?.rowsWritten).toBe(1);
  expect(
    samples
      .filter((sample) => sample.owner === 'D1')
      .reduce((sum, sample) => sum + sample.rowsWritten, 0)
  ).toBeGreaterThan(0);
  expect(
    samples.find((sample) => sample.statement.includes('INSERT INTO do_meta'))?.rowsWritten
  ).toBe(2);
});
