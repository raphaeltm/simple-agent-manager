import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { upsertActivityState } from '../../src/durable-objects/project-data/session-state';
import type { Env } from '../../src/env';
import { runTerminalSessionLedgerReconciliation } from '../../src/scheduled/terminal-session-ledger-reconciliation';
import { cancelSleepForActiveActivity } from '../../src/services/acp-activity-callback-flush';
import * as projectData from '../../src/services/project-data';
import { cancelScheduledSessionSleep } from '../../src/services/session-snapshots';
import {
  seedInstallation,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const bindings = env as unknown as Env;
const completedAt = '2026-08-30T00:05:00.000Z';

async function setup() {
  const id = `drain-${crypto.randomUUID()}`;
  await seedUser(id);
  await seedInstallation(id, id, { installationIdValue: id });
  await seedProject(id, id, id);
  await seedWorkspace(id, null, id, { projectId: id, status: 'running' });
  const sessionId = await projectData.createSession(bindings, id, id, 'Final response', id, id);
  await seedTask(id, id, id, {
    status: 'completed',
    chatSessionId: sessionId,
    workspaceId: id,
    startedAt: '2026-08-29T20:00:00.000Z',
    completedAt,
    updatedAt: completedAt,
  });
  const stub = env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(id)
  ) as DurableObjectStub<ProjectDataTestDouble>;
  await stub.ensureProjectId(id);
  await stub.runSummarySyncForTest();
  return { id, sessionId, stub };
}

async function seedIntent(id: string, sessionId: string, status = 'scheduled') {
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
    (id, project_id, workspace_id, user_id, chat_session_id, runtime, status,
     sleep_status, sleep_after, sleep_claim_id, sleep_claimed_at, created_at, updated_at, manifest_r2_key, expires_at)
    VALUES (?, ?, ?, ?, ?, 'vm', 'pending', ?, ?, 'old-claim', ?, ?, ?, 'test/manifest.json', '2026-08-31T00:00:00.000Z')`
  )
    .bind(id, id, id, id, sessionId, status, completedAt, completedAt, completedAt, completedAt)
    .run();
}

async function intent(id: string) {
  return env.DATABASE.prepare(
    'SELECT sleep_status, sleep_after, sleep_claim_id FROM session_snapshots WHERE id = ?'
  )
    .bind(id)
    .first();
}

async function assertOpen(id: string, sessionId: string) {
  expect((await projectData.getSession(bindings, id, sessionId))?.status).toBe('active');
  expect(
    await env.DATABASE.prepare('SELECT status FROM session_summaries WHERE id = ?')
      .bind(sessionId)
      .first()
  ).toMatchObject({ status: 'active' });
}

describe('completion response survives terminal ledger cleanup', () => {
  it.each(['scheduled', 'preparing'])(
    'preserves the %s completion intent during a working callback and accepts final text',
    async (status) => {
      const { id, sessionId } = await setup();
      await seedIntent(id, sessionId, status);
      await cancelSleepForActiveActivity({
        env: bindings,
        projectId: id,
        sessionId: id,
        chatSessionId: sessionId,
        body: { activity: 'prompting', nodeId: id },
      });
      expect(await intent(id)).toMatchObject({
        sleep_status: 'scheduled',
        sleep_after: completedAt,
        sleep_claim_id: null,
      });
      await runTerminalSessionLedgerReconciliation(bindings, new Date('2026-08-30T00:06:00.000Z'));
      await assertOpen(id, sessionId);
      const messageId = crypto.randomUUID();
      expect(
        await projectData.persistMessageBatch(bindings, id, sessionId, [
          {
            messageId,
            role: 'assistant',
            content: 'The remaining final response.',
            toolMetadata: null,
            timestamp: '2026-08-30T00:06:01.000Z',
          },
        ])
      ).toMatchObject({ persisted: 1 });
      expect(
        (await projectData.getMessages(bindings, id, sessionId)).messages.some(
          (m) => m.id === messageId
        )
      ).toBe(true);
      await cancelSleepForActiveActivity({
        env: bindings,
        projectId: id,
        sessionId: id,
        chatSessionId: sessionId,
        body: { activity: 'prompting', nodeId: id },
      });
      expect(await intent(id)).toMatchObject({
        sleep_status: 'scheduled',
        sleep_after: completedAt,
      });
      // Explicit wake still cancels, even if the previous task was completed.
      await cancelScheduledSessionSleep(drizzle(env.DATABASE, { schema }), sessionId);
      expect(await intent(id)).toMatchObject({
        sleep_status: null,
        sleep_after: null,
        sleep_claim_id: null,
      });
    }
  );

  it.each(['absent', 'old-prompt', 'missing-completed-at'])(
    'protects recent completion with %s activity before a sleep intent exists, then expires',
    async (activity) => {
      const { id, sessionId, stub } = await setup();
      if (activity === 'missing-completed-at') {
        await env.DATABASE.prepare('UPDATE tasks SET completed_at = NULL WHERE id = ?')
          .bind(id)
          .run();
      }
      if (activity === 'old-prompt') {
        const acp = await stub.createAcpSession({
          chatSessionId: sessionId,
          initialPrompt: 'Work',
          agentType: 'codex',
        });
        await runInDurableObject(stub, (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE acp_sessions SET status = 'running', workspace_id = ? WHERE id = ?",
            id,
            acp.id
          );
          upsertActivityState(state.storage.sql, acp.id, {
            activity: 'prompting',
            now: Date.parse('2026-08-29T20:00:00.000Z'),
          });
        });
      }
      await runTerminalSessionLedgerReconciliation(bindings, new Date('2026-08-30T00:06:00.000Z'));
      await assertOpen(id, sessionId);
      expect(
        await env.DATABASE.prepare(
          'SELECT terminal_reconcile_defer_reason FROM session_summaries WHERE id = ?'
        )
          .bind(sessionId)
          .first()
      ).toMatchObject({ terminal_reconcile_defer_reason: 'authoritative_session_open' });
      await runTerminalSessionLedgerReconciliation(bindings, new Date('2026-08-30T02:00:00.000Z'));
      expect((await projectData.getSession(bindings, id, sessionId))?.status).toBe('stopped');
      expect(
        await env.DATABASE.prepare('SELECT status FROM session_summaries WHERE id = ?')
          .bind(sessionId)
          .first()
      ).toMatchObject({ status: 'stopped' });
    }
  );

  it.each(['prompting', 'background-work'])(
    'protects fresh canonical %s after the completion grace expires, then releases it',
    async (activity) => {
      const { id, sessionId, stub } = await setup();
      const acp = await stub.createAcpSession({
        chatSessionId: sessionId,
        initialPrompt: 'Work',
        agentType: 'codex',
      });
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE acp_sessions SET status = 'running', workspace_id = ? WHERE id = ?",
          id,
          acp.id
        );
        upsertActivityState(state.storage.sql, acp.id, {
          activity: activity === 'prompting' ? 'prompting' : 'idle',
          runtimeWorkState: activity === 'background-work' ? 'active' : 'inactive',
          runtimeWorkCount: activity === 'background-work' ? 1 : 0,
          runtimeWorkProgressAt: Date.parse('2026-08-30T01:59:00.000Z'),
          now: Date.parse('2026-08-30T01:59:00.000Z'),
        });
      });
      await runTerminalSessionLedgerReconciliation(bindings, new Date('2026-08-30T02:00:00.000Z'));
      await assertOpen(id, sessionId);
      await runTerminalSessionLedgerReconciliation(bindings, new Date('2026-08-30T04:00:00.000Z'));
      expect((await projectData.getSession(bindings, id, sessionId))?.status).toBe('stopped');
    }
  );

  it('cancels for a new live task but cannot steal an already stopping claim', async () => {
    const { id, sessionId } = await setup();
    await seedIntent(id, sessionId);
    await env.DATABASE.prepare('UPDATE tasks SET chat_session_id = NULL WHERE id = ?')
      .bind(id)
      .run();
    await seedTask(`${id}-live`, id, id, {
      status: 'in_progress',
      chatSessionId: sessionId,
      workspaceId: id,
    });
    expect(
      await env.DATABASE.prepare('SELECT status FROM tasks WHERE id = ?').bind(`${id}-live`).first()
    ).toMatchObject({ status: 'in_progress' });
    const report = {
      env: bindings,
      projectId: id,
      sessionId: id,
      chatSessionId: sessionId,
      body: { activity: 'prompting' as const, nodeId: id },
    };
    await cancelSleepForActiveActivity(report);
    expect(await intent(id)).toMatchObject({ sleep_status: null, sleep_after: null });
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_status = 'stopping', sleep_claim_id = 'teardown' WHERE id = ?"
    )
      .bind(id)
      .run();
    await cancelSleepForActiveActivity(report);
    expect(await intent(id)).toMatchObject({
      sleep_status: 'stopping',
      sleep_claim_id: 'teardown',
    });
  });
});
