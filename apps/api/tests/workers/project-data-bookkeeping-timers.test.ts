import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectDataStub } from './helpers/archive-fixtures';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

afterEach(() => vi.restoreAllMocks());

describe('bookkeeping timers across real sleep and wake transitions', () => {
  it.each([false, true])(
    'preserves fresh ingest when an old cleanup fires after wake and eviction (merging=%s)',
    async (enabled) => {
      // Future storage deadlines prevent native wall-clock delivery from racing the
      // explicit alarm; production receipt and timer calculations use this clock.
      const base = Date.now() + 60000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
      vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
        enabled,
        maxRowBytes: 65536,
        recentIds: 200,
        bookkeepingIntervalMs: 30000,
      });
      const suffix = crypto.randomUUID();
      const projectId = `timers-project-${suffix}`,
        owner = `timers-owner-${suffix}`;
      const workspaceId = `timers-workspace-${suffix}`,
        nodeId = `timers-node-${suffix}`;
      const taskId = `timers-task-${suffix}`;
      await seedUser(owner);
      await seedInstallation(projectId, owner);
      await seedProject(projectId, owner, projectId);
      await seedNode(nodeId, owner, { status: 'running' });
      const stub = projectDataStub(projectId);
      await stub.ensureProjectId(projectId);
      const session = await stub.createSession(
        workspaceId,
        'Synthetic sleep and wake timers'
      );
      await seedWorkspace(workspaceId, nodeId, owner, {
        projectId,
        chatSessionId: session,
        status: 'running',
      });
      await seedTask(taskId, projectId, owner, {
        chatSessionId: session,
        workspaceId,
        status: 'in_progress',
      });
      await stub.linkSessionToTask(session, taskId);
      const acp = await stub.createAcpSession({
        chatSessionId: session,
        initialPrompt: null,
        agentType: 'claude-code',
      });
      await runInDurableObject(stub, (instance) => {
        const holder = instance as unknown as { env: Record<string, unknown> };
        holder.env = { ...holder.env, SESSION_IDLE_TIMEOUT_MINUTES: '1' };
      });
      await stub.reportActivity(acp.id, 'prompting', {
        observedAt: base,
        promptStartedAt: base,
      });
      await stub.scheduleIdleCleanup(session, workspaceId, taskId);
      const source = {
        workspaceId,
        callbackGeneration: 'timers-generation',
        outboxIncarnation: 'timers-outbox',
      };
      const ingest = (position: number, now: number, target = stub) =>
        target.persistMessageBatch(
          session,
          [
            {
              messageId: `timer-chunk-${position}`,
              role: 'assistant',
              content: 'synthetic timer chunk',
              toolMetadata: null,
              timestamp: new Date(now).toISOString(),
              sequence: position,
            },
          ],
          source
        );
      await ingest(1, base);
      clock.mockReturnValue(base + 2000);
      await ingest(2, base + 2000);
      expect((await stub.getSession(session))?.messageCount).toBe(2);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              'SELECT message_count,pending_message_count FROM chat_sessions WHERE id=?',
              session
            )
            .one()
        ).toMatchObject({ message_count: 0, pending_message_count: 2 });
      });

      clock.mockReturnValue(base + 3000);
      expect(await stub.sleepSession(session)).toBe(true);
      const oldCleanupAt = await stub.getCleanupAt(session);
      expect(oldCleanupAt).toBe(base + 62000);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              'SELECT status,message_count,pending_message_count FROM chat_sessions WHERE id=?',
              session
            )
            .one()
        ).toMatchObject({
          status: 'sleeping',
          message_count: 2,
          pending_message_count: 0,
        });
      });
      clock.mockReturnValue(base + 58000);
      expect(await stub.wakeSession(session, workspaceId, taskId)).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              'SELECT status,message_count,pending_message_count FROM chat_sessions WHERE id=?',
              session
            )
            .one()
        ).toMatchObject({ status: 'active', message_count: 2, pending_message_count: 0 });
      });
      await stub.reportActivity(acp.id, 'prompting', {
        observedAt: base + 58000,
        promptStartedAt: base + 58000,
      });
      clock.mockReturnValue(base + 58500);
      await ingest(3, base + 58500);
      expect((await stub.getSession(session))?.messageCount).toBe(3);
      // Waking an indexed merged run seals its old row and can fold the first
      // post-wake batch immediately. The following batch must still leave a real
      // pending receipt before the currently persisted cleanup deadline.
      const staleCleanupAt = Number(await stub.getCleanupAt(session));
      const freshAt = staleCleanupAt - 1500;
      clock.mockReturnValue(freshAt);
      await ingest(4, freshAt);
      expect((await stub.getSession(session))?.messageCount).toBe(4);
      await runInDurableObject(stub, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              'SELECT message_count,pending_message_count,message_idle_after,message_bookkeeping_due_at FROM chat_sessions WHERE id=?',
              session
            )
            .one()
        ).toMatchObject({
          message_count: enabled ? 3 : 2,
          pending_message_count: enabled ? 1 : 2,
          message_idle_after: freshAt + 60000,
          message_bookkeeping_due_at: enabled ? freshAt + 30000 : base + 88500,
        });
      });
      // The receipt is still pending, and the old cleanup really is due before its
      // normal fold. Neither an in-memory cache nor a successful liveness probe can save it.
      const liveness = vi
        .spyOn(projectDataPorts().taskLiveness, 'getLocalTaskRuntimeVerdict')
        .mockResolvedValue({
          live: false,
          conclusive: true,
          reason: 'synthetic_dead',
          supersededTermination: false,
          evidenceLogFields: {},
          delivery: { kind: 'terminal', reason: 'synthetic_dead', nodeId },
        });
      await evictDurableObject(stub);
      const resumed = projectDataStub(projectId);
      clock.mockReturnValue(staleCleanupAt + 1);
      expect(await runDurableObjectAlarm(resumed)).toBe(true);
      expect(liveness).not.toHaveBeenCalled();
      expect((await resumed.getSession(session))?.status).toBe('active');
      expect((await resumed.getSession(session))?.messageCount).toBe(4);
      await runInDurableObject(resumed, (_instance, state) => {
        expect(
          state.storage.sql
            .exec(
              'SELECT message_count,pending_message_count FROM chat_sessions WHERE id=?',
              session
            )
            .one()
        ).toMatchObject({ message_count: 4, pending_message_count: 0 });
        expect(
          state.storage.sql
            .exec(
              'SELECT cleanup_at,retry_count,last_error FROM idle_cleanup_schedule WHERE session_id=?',
              session
            )
            .one()
        ).toMatchObject({
          cleanup_at: freshAt + 60000,
          retry_count: 0,
          last_error: null,
        });
      });
      expect((await resumed.getSessionState(acp.id))?.workAt).toBe(freshAt);
      expect(
        await env.DATABASE.prepare('SELECT status FROM tasks WHERE id=?')
          .bind(taskId)
          .first()
      ).toMatchObject({ status: 'in_progress' });
      expect(
        await env.DATABASE.prepare('SELECT status FROM workspaces WHERE id=?')
          .bind(workspaceId)
          .first()
      ).toMatchObject({ status: 'running' });
    }
  );
});
