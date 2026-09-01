import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import * as projectDataService from '../../src/services/project-data';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';
import {
  captureProjectDataExpectedError,
  type ProjectDataTestDouble,
} from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-bridge-owner';
const INSTALLATION = 'archive-bridge-installation';

function projectDataStub(ownerName: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(ownerName)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

async function seedProjectGraph(projectId: string): Promise<void> {
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, {
    name: `Archive Bridge ${projectId}`,
  });
}

async function withArchiveEnv<T>(
  overrides: Partial<Record<keyof WorkerEnv, string>>,
  fn: () => Promise<T>
): Promise<T> {
  const mutableEnv = testEnv as WorkerEnv & Record<string, string | undefined>;
  const previous = new Map<string, string | undefined>();
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

function largeMessage(index: number): string {
  return `archive bridge payload ${index} ${'x'.repeat(24 * 1024)}`;
}

async function readLocation(projectId: string, sessionId: string) {
  return env.DATABASE.prepare(
    `SELECT location_state, owner_kind, owner_name, generation, migration_id, target_aggregate_sha256
     FROM project_data_session_locations
     WHERE project_id = ? AND session_id = ?`
  )
    .bind(projectId, sessionId)
    .first<{
      location_state: string;
      owner_kind: string;
      owner_name: string;
      generation: number;
      migration_id: string | null;
      target_aggregate_sha256: string | null;
    }>();
}

describe('ProjectData archive-sharding bridge in the Workers runtime', () => {
  it('migrates a terminal transcript through real DO SQLite, publishes archive routing, and records databaseSize reclaim evidence', async () => {
    const projectId = `archive-bridge-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Workers archive bridge');
    for (let index = 0; index < 12; index++) {
      await source.persistMessage(sessionId, index % 2 === 0 ? 'user' : 'assistant', largeMessage(index), null);
    }
    await source.stopSession(sessionId);
    await source.runSummarySyncForTest();

    const rootBefore = await runInDurableObject(
      source,
      async (_instance, state) => state.storage.sql.databaseSize
    );

    await withArchiveEnv(
      {
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
        PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '4',
        PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '3',
        PROJECT_DATA_ARCHIVE_CHUNK_BYTES: String(128 * 1024),
      },
      async () => {
        const stats = await runProjectDataArchiveSharding(
          testEnv,
          new Date(Date.now() + 60_000)
        );
        expect(stats).toMatchObject({
          enabled: true,
          skipped: false,
          migrated: 1,
          failed: 0,
        });

        const location = await readLocation(projectId, sessionId);
        expect(location).toMatchObject({
          location_state: 'archive_shard',
          owner_kind: 'archive_shard',
          generation: 1,
        });
        expect(location?.owner_name).toContain(':archive:g1:');
        expect(location?.migration_id).toBeTruthy();
        expect(location?.target_aggregate_sha256).toMatch(/^[a-f0-9]{64}$/);

        const routed = await projectDataService.getMessages(
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
        expect(routed.messages).toHaveLength(12);
        expect(routed.messages[0]?.content).toContain('archive bridge payload 0');
        await expect(
          projectDataService.persistMessage(testEnv, projectId, sessionId, 'assistant', 'late write', null)
        ).rejects.toMatchObject({ code: 'PROJECT_DATA_ARCHIVE_ROUTING_UNSAFE' });

        const sourceProof = await runInDurableObject(source, async (_instance, state) => {
          const sql = state.storage.sql;
          const intent = sql
            .exec(
              `SELECT state, source_database_size_before, source_database_size_after
               FROM project_data_archive_source_intents
               WHERE session_id = ?`,
              sessionId
            )
            .toArray()[0] as {
            state: string;
            source_database_size_before: number;
            source_database_size_after: number;
          };
          const rootMessages = sql
            .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
            .toArray()[0] as { count: number };
          return {
            intent,
            rootMessages: rootMessages.count,
            databaseSize: sql.databaseSize,
          };
        });
        expect(sourceProof.intent.state).toBe('source_deleted');
        expect(sourceProof.intent.source_database_size_before).toBeGreaterThanOrEqual(rootBefore);
        expect(sourceProof.intent.source_database_size_after).toBeLessThan(
          sourceProof.intent.source_database_size_before
        );
        expect(sourceProof.rootMessages).toBe(0);
        expect(sourceProof.databaseSize).toBe(sourceProof.intent.source_database_size_after);

        const target = projectDataStub(location!.owner_name);
        const targetRows = await runInDurableObject(target, async (_instance, state) => {
          const sql = state.storage.sql;
          const messages = sql
            .exec('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?', sessionId)
            .toArray()[0] as { count: number };
          const chunks = sql
            .exec(
              'SELECT COUNT(*) AS count FROM project_data_archive_target_chunks WHERE session_id = ?',
              sessionId
            )
            .toArray()[0] as { count: number };
          return { messages: messages.count, chunks: chunks.count };
        });
        expect(targetRows.messages).toBe(12);
        expect(targetRows.chunks).toBeGreaterThan(0);
      }
    );
  });

  it('fails closed for DO-local transcript writes after a source archive intent is prepared', async () => {
    const projectId = `archive-local-fence-${crypto.randomUUID()}`;
    await seedProjectGraph(projectId);
    const source = projectDataStub(projectId);
    await source.ensureProjectId(projectId);
    const sessionId = await source.createSession(null, 'Local archive write fence');
    await source.persistMessage(sessionId, 'user', 'before archive', null);
    await source.stopSession(sessionId);

    await source.archiveSourcePrepareIntent({
      projectId,
      sessionId,
      migrationId: 'migration-local-fence',
      sourceOwnerName: projectId,
      targetOwnerName: `${projectId}:archive:g1:s1`,
      targetGeneration: 1,
      sourceIntentToken: 'source-intent-local-fence',
      now: Date.now() + 60_000,
      minTerminalAgeMs: 1,
    });

    const captured = await captureProjectDataExpectedError(source, {
      operation: 'persistMessage',
      args: [sessionId, 'assistant', 'late local write', null],
    });
    expect(captured).toMatchObject({
      threw: true,
      code: 'PROJECT_DATA_TRANSCRIPT_WRITE_FENCED',
    });
  });
});
