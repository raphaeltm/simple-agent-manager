import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import {
  computeReconciliationAlarmTime,
  getReconciliationCandidates,
} from '../../src/durable-objects/project-data/reconciliation';
import {
  ensureReconciliationEpisode,
  readReconciliationEpisode,
  writeReconciliationEpisode,
} from '../../src/durable-objects/project-data/reconciliation-episode';
import { guardReconciliationLoop } from '../../src/durable-objects/project-data/reconciliation-loop';

/** Real DO RPC message ingress and Workers SQLite; no deployed test endpoint. */
describe('reconciliation pause through Workers message ingress', () => {
  it('pauses the current Codex plain-text error on the first response', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.newUniqueId()
    ) as DurableObjectStub<ProjectData>;
    const sessionId = await stub.createSession('ws-plain', 'Plain runtime error', 'task-plain');
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: 'plain-warning',
        role: 'assistant',
        content:
          'Warning: Model metadata for `sam-loop-invalid-model` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.\n\n',
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
      {
        messageId: 'plain-error',
        role: 'assistant',
        content:
          "The 'sam-loop-invalid-model' model is not supported when using Codex with a ChatGPT account.\n\n",
        toolMetadata: null,
        timestamp: new Date().toISOString(),
      },
    ]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(readReconciliationEpisode(state.storage.sql, sessionId)).toMatchObject({
        paused: true,
        attempts: 0,
      });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS n FROM session_attention_markers WHERE source = 'reconciliation_loop' AND resolved_at IS NULL"
          )
          .one().n
      ).toBe(1);
    });
  });

  it('persists a pause across RPCs and allows a human retry without deleting work', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.newUniqueId()
    ) as DurableObjectStub<ProjectData>;
    const sessionId = await stub.createSession('ws-loop', 'Retry preservation', 'task-loop');
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const episode = ensureReconciliationEpisode(sql, sessionId);
      writeReconciliationEpisode(sql, sessionId, { ...episode, attempts: 3 });
      const classifierEnv = { ...env, STALLED_TASK_CLASSIFIER_ENABLED: 'false' };
      const allowed = await guardReconciliationLoop(
        sql,
        classifierEnv,
        {
          sessionId,
          taskId: 'task-loop',
          workspaceId: 'ws-loop',
          projectId: 'project-loop',
          acpSessionId: 'acp-loop',
          lastActivityAt: Date.now(),
          idleDurationMs: 0,
          action: 'checkin',
          promptStartedAt: null,
          promptAgeMs: null,
        },
        () => {}
      );
      expect(allowed).toBe(false);
    });
    await stub.persistMessageBatch(sessionId, [
      {
        messageId: 'automated-loop-message',
        role: 'user',
        content: 'automated wake',
        toolMetadata: null,
        origin: 'system',
        timestamp: new Date().toISOString(),
      },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(readReconciliationEpisode(state.storage.sql, sessionId)).toMatchObject({
        paused: true,
        attempts: 3,
      });
      expect(computeReconciliationAlarmTime(state.storage.sql, env)).toBeNull();
      expect(await getReconciliationCandidates(state.storage.sql, env)).toEqual([]);
      expect(
        state.storage.sql.exec('SELECT status FROM chat_sessions WHERE id = ?', sessionId).one()
          .status
      ).toBe('active');
    });
    await stub.persistMessage(sessionId, 'user', 'I fixed the runtime. Continue.', null);
    await runInDurableObject(stub, (_instance, state) => {
      expect(readReconciliationEpisode(state.storage.sql, sessionId)).toMatchObject({
        paused: false,
        attempts: 0,
      });
      expect(
        state.storage.sql
          .exec(
            "SELECT COUNT(*) AS n FROM session_attention_markers WHERE source = 'reconciliation_loop' AND resolved_at IS NULL"
          )
          .one().n
      ).toBe(0);
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS n FROM chat_messages WHERE role = 'system'")
          .one().n
      ).toBe(1);
    });
  });
});
