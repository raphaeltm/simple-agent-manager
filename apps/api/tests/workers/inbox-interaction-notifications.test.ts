/**
 * Inbox slice E, ACP interactions, in the Workers runtime (`.claude/rules/62`): a permission
 * request created through the real VM-agent callback route sends one `needs_input` notification
 * to the chat's creator, linking its inbox item, however often the projection job runs; and an
 * answer the agent never confirmed files one `error` item for that person.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InteractionStore } from '../../src/durable-objects/interaction-store';
import { projectInteractionAttention } from '../../src/durable-objects/interaction-store-attention';
import type { NotificationService } from '../../src/durable-objects/notification';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { acpInteractionCallbackRoute } from '../../src/routes/projects/acp-interaction-callback';
import { signCallbackToken } from '../../src/services/jwt';
import * as projectDataService from '../../src/services/project-data';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const testEnv = env as unknown as Env;
const CANARY_COMMAND = 'rm -rf /srv/CANARY-command-line';

function callbackApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(handleAppError);
  app.route('/api/projects', acpInteractionCallbackRoute);
  return app;
}

async function setup() {
  const suffix = crypto.randomUUID();
  const userId = `inbox-e-user-${suffix}`;
  const installationId = `inbox-e-installation-${suffix}`;
  const projectId = `inbox-e-project-${suffix}`;
  const nodeId = `inbox-e-node-${suffix}`;
  const workspaceId = `inbox-e-workspace-${suffix}`;
  const agentSessionId = `inbox-e-agent-${suffix}`;
  const interactionId = crypto.randomUUID();
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);
  const chatSessionId = await projectDataService.createSession(
    testEnv,
    projectId,
    workspaceId,
    'Inbox slice E permission',
    null,
    userId
  );
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    chatSessionId,
    status: 'running',
  });
  await seedAgentSession(agentSessionId, workspaceId, userId, { status: 'running' });
  const callbackToken = await signCallbackToken(workspaceId, testEnv, { callbackGeneration: null });
  const created = await callbackApp().request(
    `/api/projects/${projectId}/workspaces/${workspaceId}/acp-interactions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${callbackToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        interactionId,
        generation: crypto.randomUUID(),
        runtimeIdentity: 'runtime-inbox-e',
        agentSessionId,
        kind: 'permission',
        payloadHash: 'a'.repeat(64),
        detail: {
          permissionName: CANARY_COMMAND,
          options: [{ id: 'allow', kind: 'allow_once', name: 'Allow once' }],
        },
        safeSummary: { toolCallId: 'tool-inbox-e', optionCount: 1 },
        deadlineAt: Date.now() + 60_000,
      }),
    },
    testEnv
  );
  expect(created.status).toBe(201);
  const store = testEnv.INTERACTION_STORE.get(
    testEnv.INTERACTION_STORE.idFromName(`${projectId}/${chatSessionId}`)
  ) as DurableObjectStub<InteractionStore>;
  const notifications = testEnv.NOTIFICATION.get(
    testEnv.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
  return { userId, projectId, chatSessionId, interactionId, store, notifications };
}

async function drain(store: DurableObjectStub<InteractionStore>) {
  // Run due outbox jobs (projection, resolve) the way the store's alarm does.
  for (let i = 0; i < 3; i += 1) await runDurableObjectAlarm(store);
}

describe('ACP interaction notifications and undelivered answers (slice E)', () => {
  beforeEach(() => {
    (testEnv as unknown as Record<string, string>).ACP_INTERACTIONS_ENABLED = 'true';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 }))
    );
  });
  afterEach(() => {
    delete (testEnv as unknown as Record<string, string>).ACP_INTERACTIONS_ENABLED;
    vi.unstubAllGlobals();
  });

  it('notifies the chat creator once per permission request, linking its inbox item', async () => {
    const { userId, projectId, chatSessionId, interactionId, store, notifications } = await setup();
    await drain(store);

    const markerId = await runInDurableObject(store, async (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT attention_marker_id FROM interactions WHERE interaction_id = ?',
          interactionId
        )
        .one() as { attention_marker_id: string | null };
      return row.attention_marker_id;
    });
    expect(markerId).toBeTruthy();
    // A replayed projection (outbox retry, alarm re-run) must not notify again.
    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE interactions SET attention_marker_id = NULL WHERE interaction_id = ?',
        interactionId
      );
      await projectInteractionAttention(state.storage.sql, testEnv, interactionId);
    });

    const { notifications: list } = await notifications.listNotifications(userId, {
      projectId,
    });
    const needsInput = list.filter((n) => n.type === 'needs_input');
    expect(needsInput).toHaveLength(1);
    expect(needsInput[0]).toMatchObject({
      urgency: 'high',
      sessionId: chatSessionId,
      actionUrl: `/projects/${projectId}/inbox?item=${encodeURIComponent(
        `attention:${chatSessionId}:${markerId}`
      )}`,
    });
    // The tool call the agent asked about never reaches the notification.
    expect(JSON.stringify(needsInput)).not.toContain('CANARY');

    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM outbox`);
      await state.storage.deleteAlarm();
    });
  });

  it('does not notify a chat creator who is no longer a project member', async () => {
    // The creator was removed after starting the chat, before the request arrived.
    const removed = await setup();
    await testEnv.DATABASE.prepare(
      'DELETE FROM project_members WHERE project_id = ? AND user_id = ?'
    )
      .bind(removed.projectId, removed.userId)
      .run();
    await drain(removed.store);

    // Liveness: the projection ran (the inbox still holds the request), it only told nobody.
    const markerId = await runInDurableObject(removed.store, async (_instance, state) => {
      const row = state.storage.sql
        .exec(
          'SELECT attention_marker_id FROM interactions WHERE interaction_id = ?',
          removed.interactionId
        )
        .one() as { attention_marker_id: string | null };
      return row.attention_marker_id;
    });
    expect(markerId).toBeTruthy();
    const { notifications: list } = await removed.notifications.listNotifications(removed.userId, {
      projectId: removed.projectId,
    });
    expect(list.filter((n) => n.type === 'needs_input')).toHaveLength(0);

    await runInDurableObject(removed.store, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM outbox`);
      await state.storage.deleteAlarm();
    });
  });

  it('files one error item when the person’s answer was never confirmed delivered', async () => {
    const { userId, projectId, chatSessionId, interactionId, store } = await setup();
    await drain(store);
    // The person answered; then the delivery window ran out (`processDeliveryJob`).
    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE interactions SET state = 'answered' WHERE interaction_id = ?`,
        interactionId
      );
    });
    await store.recordDelivery(interactionId, 'unconfirmed', 'delivery deadline elapsed');
    await drain(store);
    await drain(store);

    const items = await testEnv.DATABASE.prepare(
      `SELECT assignee_user_id, source_session_id, title, status, answer_spec_json FROM asks
        WHERE project_id = ? AND kind = 'error'`
    )
      .bind(projectId)
      .all<Record<string, string>>();
    expect(items.results).toHaveLength(1);
    expect(items.results[0]).toMatchObject({
      assignee_user_id: userId,
      status: 'open',
      title: expect.stringContaining("didn't reach the agent"),
    });
    expect(JSON.parse(items.results[0]!.answer_spec_json!)).toEqual({
      type: 'actions',
      actions: [{ id: 'open_chat', label: 'Open chat' }],
    });
    expect(chatSessionId).toBeTruthy();

    await runInDurableObject(store, async (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM outbox`);
      await state.storage.deleteAlarm();
    });
  });
});
