/** Real DO RPC + SQLite guard, including a missing attention projection. */
import { ACP_INTERACTION_ATTENTION_SOURCE } from '@simple-agent-manager/shared';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import { classifyLongRunningTaskStall } from '../../src/scheduled/stalled-task-classifier';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const HOUR = 3_600_000;

describe('stalled-turn human-input guard across real Durable Objects', () => {
  it.each(['absent', 'no-expiry'] as const)(
    'protects pending and answered requests with an %s ACP projection until their canonical deadline',
    async (projection) => {
      const projectId = `stall-input-${crypto.randomUUID()}`;
      const userId = `user-${projectId}`;
      const installationId = `install-${projectId}`;
      await seedUser(userId);
      await seedInstallation(installationId, userId);
      await seedProject(projectId, userId, installationId);
      const bindings = env as unknown as Env;
      const project = bindings.PROJECT_DATA.get(
        bindings.PROJECT_DATA.idFromName(projectId)
      ) as DurableObjectStub<ProjectData>;
      await project.ensureProjectId(projectId);
      const taskId = 'waiting-task';
      const sessionId = await project.createSession(null, 'Waiting for a human', taskId);
      const now = Date.now();
      await project.persistMessageBatch(sessionId, [
        {
          messageId: 'old-tool',
          role: 'tool',
          content: 'Checking permission.',
          toolMetadata: null,
          timestamp: new Date(now - 2 * HOUR).toISOString(),
        },
      ]);
      const store = bindings.INTERACTION_STORE.get(
        bindings.INTERACTION_STORE.idFromName(`${projectId}/${sessionId}`)
      ) as DurableObjectStub<InteractionStore>;
      const previous = bindings.ACP_INTERACTIONS_ENABLED;
      bindings.ACP_INTERACTIONS_ENABLED = 'true';
      const interactionId = crypto.randomUUID();
      try {
        expect(
          await store.create({
            protocolVersion: 1,
            projectId,
            chatSessionId: sessionId,
            interactionId,
            generation: crypto.randomUUID(),
            runtimeIdentity: 'runtime-1',
            agentSessionId: 'agent-1',
            kind: 'permission',
            payloadHash: 'a'.repeat(64),
            deadlineAt: now + HOUR,
            detail: { permissionName: 'Run tests', options: [{ id: 'allow', label: 'Allow' }] },
            safeSummary: { toolCallId: 'tool-1', optionCount: 1 },
          })
        ).toMatchObject({ status: 'created' });
        await runInDurableObject(project, async (_instance, state) => {
          state.storage.sql.exec('DELETE FROM session_attention_markers');
          await state.storage.deleteAlarm();
        });
        if (projection === 'no-expiry') {
          const marker = await project.createAttentionMarker({
            sessionId,
            taskId: null,
            workspaceId: null,
            kind: 'needs_input',
            source: ACP_INTERACTION_ATTENTION_SOURCE,
            reason: 'acp_interaction_pending',
            metadata: JSON.stringify({ interactionId, state: 'pending' }),
            expiresAt: null,
          });
          expect(marker.expiresAt).toBeNull();
        }
        await runInDurableObject(store, async (_instance, state) => {
          // Expiry alarms batch work; old records can fill the UI snapshot cap.
          const columns = state.storage.sql
            .exec<{ name: string }>('PRAGMA table_info(interactions)')
            .toArray()
            .map((column) => column.name);
          const selected = columns
            .map((name) =>
              ['interaction_id', 'created_at', 'deadline_at'].includes(name) ? '?' : name
            )
            .join(', ');
          for (let index = 0; index < 64; index++) {
            state.storage.sql.exec(
              `INSERT INTO interactions (${columns.join(', ')}) SELECT ${selected}
             FROM interactions WHERE interaction_id = ?`,
              `expired-${index}`,
              now - HOUR,
              now - 1,
              interactionId
            );
          }
          state.storage.sql.exec('DELETE FROM outbox');
          await state.storage.deleteAlarm();
        });
        expect(
          (await store.snapshot()).pending.some(
            (request) => request.interactionId === interactionId
          )
        ).toBe(false);
        expect(await store.hasUnexpiredHumanInput(now)).toBe(true);
        const aiRun = vi.fn().mockResolvedValue({
          answers: { stall_status: { value: 'stalled', probabilities: { stalled: 0.99 } } },
        });
        const input = {
          task: {
            id: taskId,
            project_id: projectId,
            workspace_id: null,
            chat_session_id: sessionId,
          },
          liveness: {
            live: true,
            conclusive: true,
            reason: 'task_prompt_turn_active',
            workspaceStatus: 'running',
            nodeId: 'node-1',
            activeAcpSessionId: 'agent-1',
            evidence: {
              workState: 'prompt_turn_active',
              activity: 'prompting',
              lastActivityAgeMs: 0,
              promptStartedAgeMs: 2 * HOUR,
              runtimeWorkProgressAgeMs: null,
              acpHeartbeatAgeMs: 0,
            },
          },
          nowMs: now,
        } satisfies Parameters<typeof classifyLongRunningTaskStall>[1];
        const classifierEnv = { ...bindings, AI: { run: aiRun } } as unknown as Env;
        expect(await classifyLongRunningTaskStall(classifierEnv, input)).toBeNull();
        expect(aiRun).not.toHaveBeenCalled();
        await runInDurableObject(store, async (_instance, state) => {
          state.storage.sql.exec(
            "UPDATE interactions SET state = 'answered' WHERE interaction_id = ?",
            interactionId
          );
        });
        expect(await classifyLongRunningTaskStall(classifierEnv, input)).toBeNull();
        expect(aiRun).not.toHaveBeenCalled();
        expect(await store.hasUnexpiredHumanInput(now)).toBe(true);
        expect(
          (await store.snapshot()).pending.some(
            (request) => request.interactionId === interactionId
          )
        ).toBe(false);
        await runInDurableObject(store, async (_instance, state) => {
          state.storage.sql.exec(
            'UPDATE interactions SET deadline_at = ? WHERE interaction_id = ?',
            now,
            interactionId
          );
        });
        expect(await store.hasUnexpiredHumanInput(now)).toBe(false);
        // An unresolved ACP projection must not extend the canonical deadline.
        if (projection === 'no-expiry') {
          expect(await project.listActiveAttentionMarkers(sessionId)).toHaveLength(1);
        }
        expect(await classifyLongRunningTaskStall(classifierEnv, input)).toMatchObject({
          decision: 'stalled',
        });
        expect(aiRun).toHaveBeenCalledOnce();
        const marker = await project.createAttentionMarker({
          sessionId,
          taskId,
          workspaceId: null,
          kind: 'needs_input',
          source: 'request_human_input',
          expiresAt: now + HOUR,
        });
        expect(await project.hasPendingSessionHumanInput(sessionId, taskId, now)).toBe(true);
        expect(await classifyLongRunningTaskStall(classifierEnv, input)).toBeNull();
        expect(aiRun).toHaveBeenCalledOnce();
        await project.resolveAttentionMarkerById(marker.id, 'human', 'answered');
        expect(await project.hasPendingSessionHumanInput(sessionId, taskId, now)).toBe(false);
      } finally {
        bindings.ACP_INTERACTIONS_ENABLED = previous;
      }
    }
  );
});
