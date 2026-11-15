import {
  BOOKKEEPING_AWAITING_SUMMARY,
  BOOKKEEPING_SUMMARY_CURSOR_KEY,
} from '@simple-agent-manager/project-data/internal/do/message-bookkeeping';
import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());
const source = {
  workspaceId: 'summary-workspace',
  callbackGeneration: 'summary-generation',
  outboxIncarnation: 'summary-outbox',
};
function batch(id: string) {
  return [
    {
      messageId: id,
      role: 'assistant',
      content: 'synthetic summary chunk',
      toolMetadata: null,
      timestamp: new Date().toISOString(),
    },
  ];
}
async function fixture(size = 1) {
  const projectId = 'bookkeeping-summary-' + crypto.randomUUID(),
    owner = 'summary-owner';
  await seedUser(owner);
  await seedInstallation('summary-installation', owner);
  await seedProject(projectId, owner, 'summary-installation');
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
    bookkeepingIntervalMs: 15000,
    bookkeepingFlushBatchSize: 2,
  });
  const stub = projectDataStub(projectId);
  await stub.ensureProjectId(projectId);
  const sessions = [];
  for (let n = 0; n < size; n++) {
    const session = await stub.createSession(source.workspaceId, 'Synthetic summary');
    sessions.push(session);
    await stub.persistMessageBatch(session, batch('first-' + n), source);
    await stub.markAgentCompleted(session);
  }
  return { stub, projectId, sessions };
}
async function markerCount(stub: ReturnType<typeof projectDataStub>) {
  return runInDurableObject(stub, (_instance, state) =>
    Number(
      state.storage.sql
        .exec(
          'SELECT COUNT(*) AS n FROM chat_sessions WHERE message_bookkeeping_due_at=?',
          BOOKKEEPING_AWAITING_SUMMARY
        )
        .toArray()[0]?.n
    )
  );
}

describe('durable bookkeeping summary publication through real ingest', () => {
  it('reaches old queued sessions beyond a summary page among 10000 clean sessions', async () => {
    const { stub, projectId, sessions } = await fixture(5);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO chat_sessions(id,topic,status,message_count,created_at,updated_at,started_at)
    SELECT 'clean-'||x,'synthetic','stopped',0,1,1,1 FROM n`);
    });
    expect(await markerCount(stub)).toBe(5);
    for (let n = 0; n < 3; n++)
      await stub.runSummarySyncWithEnvForTest({ SESSION_INDEX_MAX_ROWS: '1' });
    expect(await markerCount(stub)).toBe(0);
    for (const session of sessions) {
      const row = await env.DATABASE.prepare(
        'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
      )
        .bind(projectId, session)
        .first<{ message_count: number }>();
      expect(row?.message_count).toBe(1);
    }
  });

  it('retains the queue and cursor on publication failure and retries after actual eviction/alarm', async () => {
    const { stub, sessions } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const holder = instance as unknown as { env: { DATABASE: D1Database } };
      const prior = holder.env;
      holder.env = {
        ...prior,
        DATABASE: new Proxy(prior.DATABASE, {
          get(target, key) {
            if (key === 'batch')
              return async () => {
                throw new Error('synthetic D1 publication failure');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
      try {
        await expect(instance.runSummarySyncForTest()).rejects.toThrow();
      } finally {
        holder.env = prior;
      }
      expect(
        state.storage.sql
          .exec('SELECT message_bookkeeping_due_at FROM chat_sessions WHERE id=?', sessions[0])
          .toArray()[0]?.message_bookkeeping_due_at
      ).toBe(BOOKKEEPING_AWAITING_SUMMARY);
      expect(
        state.storage.sql
          .exec('SELECT value FROM do_meta WHERE key=?', BOOKKEEPING_SUMMARY_CURSOR_KEY)
          .toArray()
      ).toEqual([]);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await markerCount(stub)).toBe(0);
  });

  it('does not acknowledge a receipt ingested while its older snapshot is publishing', async () => {
    const {
      stub,
      projectId,
      sessions: [session],
    } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const holder = instance as unknown as { env: { DATABASE: D1Database } };
      const prior = holder.env;
      let injected = false;
      holder.env = {
        ...prior,
        DATABASE: new Proxy(prior.DATABASE, {
          get(target, key) {
            if (key === 'batch')
              return async (statements: D1PreparedStatement[]) => {
                if (!injected) {
                  injected = true;
                  await instance.persistMessageBatch(session!, batch('during-publication'), source);
                }
                return target.batch(statements);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      };
      try {
        await instance.runSummarySyncForTest();
        expect(injected).toBe(true);
      } finally {
        holder.env = prior;
      }
    });
    expect((await stub.getSession(session!))?.messageCount).toBe(2);
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
        )
          .bind(projectId, session!)
          .first<{ message_count: number }>()
      )?.message_count
    ).toBe(1);
    await stub.markAgentCompleted(session!);
    expect(await markerCount(stub)).toBe(1);
    await stub.runSummarySyncForTest();
    expect(await markerCount(stub)).toBe(0);
    expect(
      (
        await env.DATABASE.prepare(
          'SELECT message_count FROM session_summaries WHERE project_id=? AND id=?'
        )
          .bind(projectId, session!)
          .first<{ message_count: number }>()
      )?.message_count
    ).toBe(2);
  });
});
