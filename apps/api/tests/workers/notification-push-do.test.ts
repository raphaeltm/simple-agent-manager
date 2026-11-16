import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { makeSignature } from 'better-auth/crypto';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NotificationService } from '../../src/durable-objects/notification';
import { encryptWebPushPayload } from '../../src/lib/web-push';
import { storeMcpToken } from '../../src/services/mcp-token';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const RECEIVER_PUBLIC_KEY =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';

function stub(userId: string): DurableObjectStub<NotificationService> {
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Notification DO Web Push migration and delivery', () => {
  it('runs migration 004 and round-trips subscription metadata through real row parsers', async () => {
    const notification = stub('push-subscription-user-001');
    const input = {
      endpoint: 'https://push.example.test/subscription-001',
      expirationTime: null,
      keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
    };

    const stored = await notification.addPushSubscription(
      'push-subscription-user-001',
      input,
      'Workerd Test'
    );
    expect(stored).toMatchObject({
      endpoint: input.endpoint,
      userAgent: 'Workerd Test',
      disabledAt: null,
      failureCount: 0,
    });
    expect(stored).not.toHaveProperty('p256dh');
    expect(stored).not.toHaveProperty('auth');
    expect(await notification.listPushSubscriptions('push-subscription-user-001')).toEqual([
      stored,
    ]);

    const refreshed = await notification.addPushSubscription(
      'push-subscription-user-001',
      input,
      'Refreshed Workerd Test'
    );
    expect(refreshed).toMatchObject({
      endpoint: input.endpoint,
      userAgent: 'Refreshed Workerd Test',
      disabledAt: null,
      failureCount: 0,
    });
    expect(await notification.listPushSubscriptions('push-subscription-user-001')).toEqual([
      refreshed,
    ]);

    expect(
      await notification.removePushSubscription('push-subscription-user-001', input.endpoint)
    ).toBe(true);
    expect(await notification.listPushSubscriptions('push-subscription-user-001')).toEqual([]);
  });

  it('encrypts the RFC 8291 known-answer vector under workerd WebCrypto', async () => {
    const encrypted = await encryptWebPushPayload(
      {
        endpoint: 'https://push.example.test/vector',
        p256dh: RECEIVER_PUBLIC_KEY,
        auth: AUTH_SECRET,
      },
      'When I grow up, I want to be a watermelon',
      {
        salt: 'DGv6ra1nlYgDCS1FRnbzlw',
        senderPrivateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        senderPublicKey:
          'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
      }
    );

    let binary = '';
    for (const byte of encrypted) binary += String.fromCharCode(byte);
    expect(btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
  });

  it('persists a delivery receipt after the push service accepts encrypted bytes', async () => {
    const userId = 'push-delivery-user-001';
    const notification = stub(userId);
    const created = await notification.createNotification(userId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Approval needed',
      body: 'Choose a release window',
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      actionUrl: '/projects/project-1/chat/session-1',
    });
    await notification.addPushSubscription(
      userId,
      {
        endpoint: 'https://push.example.test/subscription-delivery',
        keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
      },
      'Workerd Test'
    );

    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await runInDurableObject(notification, async (instance) => {
      await (
        instance as unknown as {
          deliverPushNotification(userId: string, notificationId: string): Promise<void>;
        }
      ).deliverPushNotification(userId, created.id);
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: expect.stringMatching(/^vapid t=/),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    });
    expect(request.body).toBeInstanceOf(Uint8Array);
    expect(await notification.hasConfirmedPushDelivery(userId, created.id)).toBe(true);
  });

  it('fans one notification out to every registered endpoint', async () => {
    const userId = `push-fanout-user-${crypto.randomUUID()}`;
    const notification = stub(userId);
    const created = await notification.createNotification(userId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Choose a release window',
    });
    const endpoints = [
      'https://push.example.test/fanout-phone',
      'https://push.example.test/fanout-laptop',
    ];
    for (const endpoint of endpoints) {
      await notification.addPushSubscription(
        userId,
        { endpoint, keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET } },
        endpoint.endsWith('phone') ? 'Phone' : 'Laptop'
      );
    }

    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await runInDurableObject(notification, async (instance) => {
      await (
        instance as unknown as {
          deliverPushNotification(userId: string, notificationId: string): Promise<void>;
        }
      ).deliverPushNotification(userId, created.id);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint).sort()).toEqual(endpoints.sort());
    expect(await notification.hasConfirmedPushDelivery(userId, created.id)).toBe(true);
  });

  it('does not deliver to any registered endpoint when Web Push is disabled', async () => {
    const userId = `push-disabled-user-${crypto.randomUUID()}`;
    const notification = stub(userId);
    for (const endpoint of [
      'https://push.example.test/disabled-phone',
      'https://push.example.test/disabled-laptop',
    ]) {
      await notification.addPushSubscription(
        userId,
        { endpoint, keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET } },
        'Disabled device'
      );
    }
    await notification.updatePreference(userId, '*', 'web_push', false);

    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await notification.createNotification(userId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Push must remain off',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await notification.listPushSubscriptions(userId)).toHaveLength(2);
  });

  it('deletes a gone endpoint and disables a repeatedly failing endpoint in real SQLite', async () => {
    const suffix = crypto.randomUUID();
    const goneUserId = `push-gone-user-${suffix}`;
    const gone = stub(goneUserId);
    const goneNotification = await gone.createNotification(goneUserId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Gone endpoint',
    });
    await gone.addPushSubscription(
      goneUserId,
      {
        endpoint: `https://push.example.test/gone-${suffix}`,
        keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
      },
      'Gone Browser'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 410 }))
    );
    await runInDurableObject(gone, async (instance) => {
      await (
        instance as unknown as {
          deliverPushNotification(userId: string, notificationId: string): Promise<void>;
        }
      ).deliverPushNotification(goneUserId, goneNotification.id);
    });
    expect(await gone.listPushSubscriptions(goneUserId)).toEqual([]);

    const failingUserId = `push-failing-user-${suffix}`;
    const failing = stub(failingUserId);
    const failingNotification = await failing.createNotification(failingUserId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Failing endpoint',
    });
    await failing.addPushSubscription(
      failingUserId,
      {
        endpoint: `https://push.example.test/failing-${suffix}`,
        keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
      },
      'Failing Browser'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 400 }))
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await runInDurableObject(failing, async (instance) => {
        await (
          instance as unknown as {
            deliverPushNotification(userId: string, notificationId: string): Promise<void>;
          }
        ).deliverPushNotification(failingUserId, failingNotification.id);
      });
    }
    expect(await failing.listPushSubscriptions(failingUserId)).toEqual([
      expect.objectContaining({ failureCount: 5, disabledAt: expect.any(String) }),
    ]);
  });

  it('refuses a private or metadata push endpoint at the DO save boundary and stores nothing', async () => {
    const userId = `push-private-save-${crypto.randomUUID()}`;
    const notification = stub(userId);
    // Called on the instance (not over RPC) so the expected rejection stays inside the test.
    await runInDurableObject(notification, async (instance) => {
      for (const endpoint of [
        'https://169.254.169.254/latest/meta-data/',
        'https://127.0.0.1:8443/push',
        'https://push.internal/send',
      ]) {
        await expect(
          instance.addPushSubscription(
            userId,
            { endpoint, keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET } },
            'Refused'
          )
        ).rejects.toThrow(/public host/);
      }
    });
    expect(await notification.listPushSubscriptions(userId)).toEqual([]);

    // Control: a push-service endpoint on a public host is stored.
    await notification.addPushSubscription(
      userId,
      {
        endpoint: 'https://push.example.test/private-save-control',
        keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
      },
      'Accepted'
    );
    expect(await notification.listPushSubscriptions(userId)).toHaveLength(1);
  });

  it('skips a stored private endpoint at delivery while still delivering to a public one', async () => {
    const userId = `push-private-stored-${crypto.randomUUID()}`;
    const notification = stub(userId);
    const created = await notification.createNotification(userId, {
      type: 'needs_input',
      urgency: 'high',
      title: 'Stored private endpoint',
    });
    const publicEndpoint = 'https://push.example.test/stored-public';
    await notification.addPushSubscription(
      userId,
      { endpoint: publicEndpoint, keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET } },
      'Public'
    );
    // A row saved before the public-host check existed: written straight into SQLite.
    const privateEndpoint = 'https://10.0.0.7/push';
    await runInDurableObject(notification, async (_instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO push_subscriptions
           (endpoint, user_id, p256dh, auth, user_agent, disabled_at, failure_count,
            last_success_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'Legacy', NULL, 0, NULL, ?, ?)`,
        privateEndpoint,
        userId,
        RECEIVER_PUBLIC_KEY,
        AUTH_SECRET,
        now,
        now
      );
    });

    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn');
    await runInDurableObject(notification, async (instance) => {
      await (
        instance as unknown as {
          deliverPushNotification(userId: string, notificationId: string): Promise<void>;
        }
      ).deliverPushNotification(userId, created.id);
    });

    // The refusal is the host check's, reported once with safe fields and no URL. (The VAPID
    // signer would also reject the endpoint, but only after retrying and without this event.)
    const refusals = warn.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('web_push.endpoint_refused'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('"reason":"host"');
    expect(refusals[0]).not.toContain('10.0.0.7');
    warn.mockRestore();
    // Liveness: the public endpoint received the push. The private one was never contacted.
    expect(fetchMock.mock.calls.map(([endpoint]) => endpoint)).toEqual([publicEndpoint]);
    expect(await notification.hasConfirmedPushDelivery(userId, created.id)).toBe(true);
    const rows = await notification.listPushSubscriptions(userId);
    const privateRow = rows.find((row) => row.endpoint === privateEndpoint);
    // The refusal goes through the ordinary failure accounting, so the row ages out.
    expect(privateRow).toEqual(expect.objectContaining({ failureCount: 1 }));
  });

  it('evicts the oldest endpoint at the configured per-user subscription ceiling', async () => {
    const userId = `push-cap-user-${crypto.randomUUID()}`;
    const notification = stub(userId);
    for (let index = 0; index < 9; index += 1) {
      await notification.addPushSubscription(
        userId,
        {
          endpoint: `https://push.example.test/cap-${index}`,
          keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
        },
        `Browser ${index}`
      );
    }

    const subscriptions = await notification.listPushSubscriptions(userId);
    expect(subscriptions).toHaveLength(8);
    expect(subscriptions.map((subscription) => subscription.endpoint)).not.toContain(
      'https://push.example.test/cap-0'
    );
  });

  it('delivers request_human_input and resolves its structured answer across real route/DO boundaries', async () => {
    const suffix = crypto.randomUUID();
    const userId = `push-vertical-user-${suffix}`;
    const installationId = `push-vertical-installation-${suffix}`;
    const projectId = `push-vertical-project-${suffix}`;
    const workspaceId = `push-vertical-workspace-${suffix}`;
    const nodeId = `push-vertical-node-${suffix}`;
    const agentSessionId = `push-vertical-agent-session-${suffix}`;
    const taskId = `push-vertical-task-${suffix}`;
    const token = `push-vertical-token-${suffix}`;
    const browserSessionToken = `push-vertical-browser-session-${suffix}`;

    await seedUser(userId);
    await seedInstallation(installationId, userId);
    await seedProject(projectId, userId, installationId, { name: 'Push Vertical Project' });
    await seedNode(nodeId, userId);
    const projectData = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
    await projectData.ensureProjectId(projectId);
    const sessionId = await projectData.createSession(
      workspaceId,
      'Push vertical session',
      taskId,
      userId
    );
    await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: sessionId });
    await seedTask(taskId, projectId, userId, { workspaceId, title: 'Ship Web Push' });
    await env.DATABASE.prepare('UPDATE tasks SET chat_session_id = ? WHERE id = ?')
      .bind(sessionId, taskId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'))`
    )
      .bind(agentSessionId, workspaceId, userId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO sessions (id, expires_at, token, created_at, updated_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `browser-session-${suffix}`,
        Date.now() + 60 * 60 * 1000,
        browserSessionToken,
        Date.now(),
        Date.now(),
        userId
      )
      .run();
    await storeMcpToken(env.KV, token, {
      taskId,
      projectId,
      userId,
      workspaceId,
      chatSessionId: sessionId,
      createdAt: new Date().toISOString(),
    });

    const notification = stub(userId);
    await notification.addPushSubscription(
      userId,
      {
        endpoint: `https://push.example.test/${suffix}`,
        keys: { p256dh: RECEIVER_PUBLIC_KEY, auth: AUTH_SECRET },
      },
      'Workerd Vertical Test'
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes(`/agent-sessions/${agentSessionId}/prompt`)) {
        return Response.json({ accepted: true });
      }
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await SELF.fetch('https://api.test.example.com/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'push-vertical-request',
        method: 'tools/call',
        params: {
          name: 'request_human_input',
          arguments: {
            context: 'Choose the release window',
            category: 'decision',
            options: ['Ship now', 'Wait'],
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const rpc = await response.json<{ error?: unknown }>();
    expect(rpc.error).toBeUndefined();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({
      Authorization: expect.stringMatching(/^vapid t=/),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
    });
    expect(request.body).toBeInstanceOf(Uint8Array);

    const listed = await notification.listNotifications(userId, { type: 'needs_input' });
    expect(listed.notifications).toHaveLength(1);
    const pushed = listed.notifications[0];
    if (!pushed) throw new Error('Expected a needs_input notification');
    expect(pushed.metadata).toMatchObject({
      attentionMarkerId: expect.any(String),
      options: ['Ship now', 'Wait'],
    });
    await vi.waitFor(async () => {
      expect(await notification.hasConfirmedPushDelivery(userId, pushed.id)).toBe(true);
    });
    // Inbox slice G: the question is one D1 `asks` row; the notification points at it.
    const marker = {
      id: String((pushed.metadata as { attentionMarkerId: string }).attentionMarkerId),
    };
    expect(await projectData.listActiveAttentionMarkers(sessionId)).toEqual([]);
    expect(
      await env.DATABASE.prepare('SELECT kind, status, notification_id FROM asks WHERE id = ?')
        .bind(marker.id)
        .first()
    ).toEqual({ kind: 'question', status: 'open', notification_id: pushed.id });
    const signedBrowserSessionToken = `${browserSessionToken}.${await makeSignature(
      browserSessionToken,
      env.BETTER_AUTH_SECRET || env.ENCRYPTION_KEY
    )}`;
    const resolveAttention = (
      markerId: string,
      answer: string,
      scope: { projectId?: string; sessionId?: string } = {}
    ) =>
      SELF.fetch(
        `https://api.test.example.com/api/projects/${scope.projectId ?? projectId}/sessions/${scope.sessionId ?? sessionId}/attention/${markerId}/resolve`,
        {
          method: 'POST',
          headers: {
            Cookie: `__Secure-better-auth.session_token=${signedBrowserSessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ answer }),
        }
      );
    const promptCalls = () =>
      fetchMock.mock.calls.filter(([input]) => {
        const url = input instanceof Request ? input.url : String(input);
        return url.includes(`/agent-sessions/${agentSessionId}/prompt`);
      });

    expect((await resolveAttention(marker.id, 'Not an option')).status).toBe(400);
    expect((await resolveAttention(`wrong-${marker.id}`, 'Ship now')).status).toBe(404);
    expect(
      (await resolveAttention(marker.id, 'Ship now', { sessionId: `wrong-${sessionId}` })).status
    ).toBe(404);
    expect(
      (await resolveAttention(marker.id, 'Ship now', { projectId: `wrong-${projectId}` })).status
    ).toBe(404);
    expect(promptCalls()).toHaveLength(0);

    const resolveResponse = await resolveAttention(marker.id, 'Ship now');
    expect(resolveResponse.status).toBe(200);
    await expect(resolveResponse.json()).resolves.toEqual({
      resolved: true,
      alreadyResolved: false,
      answer: 'Ship now',
    });
    // The answer goes to the agent as one durable prompt (the wake path), not a direct live prompt.
    const snapshot = await projectData.getDurableExecutionSnapshot(sessionId);
    expect(
      snapshot.deliveries.filter(
        (delivery: { id: string }) => delivery.id === `inbox-ask:${marker.id}`
      )
    ).toEqual([expect.objectContaining({ sourceKind: 'inbox_ask', sourceTaskId: taskId })]);

    const replayResponse = await resolveAttention(marker.id, 'Ship now');
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toEqual({
      resolved: true,
      alreadyResolved: true,
      answer: 'Ship now',
    });
    expect((await resolveAttention(marker.id, 'Wait')).status).toBe(409);
    const answered = await env.DATABASE.prepare(
      'SELECT status, answer_json, notified_at FROM asks WHERE id = ?'
    )
      .bind(marker.id)
      .first<{ status: string; answer_json: string; notified_at: number | null }>();
    expect(answered).toMatchObject({ status: 'answered', answer_json: '{"text":"Ship now"}' });
    expect(answered?.notified_at).not.toBeNull();

    // Overlap control: a question still held as a marker answers through its own path.
    const freeFormMarker = await projectData.createAttentionMarker({
      sessionId,
      taskId,
      workspaceId,
      kind: 'needs_input',
      source: 'worker_vertical_test',
      reason: 'Describe the fallback plan',
      metadata: JSON.stringify({ category: 'input' }),
    });
    const freeFormResponse = await resolveAttention(freeFormMarker.id, 'Use the canary deployment');
    expect(freeFormResponse.status).toBe(200);
    await expect(freeFormResponse.json()).resolves.toEqual({
      resolved: true,
      alreadyResolved: false,
      answer: 'Use the canary deployment',
    });
    const freeFormPrompts = promptCalls().filter(
      (call) => JSON.parse(String(call[1]?.body)).messageId === freeFormMarker.id
    );
    expect(freeFormPrompts).toHaveLength(1);
    expect(JSON.parse(String(freeFormPrompts[0]?.[1]?.body))).toEqual({
      prompt: 'Use the canary deployment',
      messageId: freeFormMarker.id,
    });
    expect(await projectData.listActiveAttentionMarkers(sessionId)).toEqual([]);
    await runInDurableObject(projectData, async (instance) => {
      const freeFormRows = (instance as unknown as { sql: SqlStorage }).sql
        .exec(
          'SELECT resolved_reason, resolved_answer FROM session_attention_markers WHERE id = ?',
          freeFormMarker.id
        )
        .toArray();
      expect(freeFormRows).toEqual([
        expect.objectContaining({
          resolved_reason: 'structured_answer',
          resolved_answer: 'Use the canary deployment',
        }),
      ]);
    });
  });
});
