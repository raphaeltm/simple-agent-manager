/**
 * Shared session access grants/revokes must push `session.access.changed` to anyone
 * watching that chat session over the project's WebSocket (idea 01M59MYE4GY91BWTE8TZF1ZB5D):
 * the chat page's access summary becomes stale the instant a grant is created or revoked, and
 * the only signal it has is this broadcast.
 *
 * Follows the exact harness shape of tests/workers/acp-session-created-broadcast.test.ts: a
 * browser-style WebSocket subscription on the chat session, then the real DO RPCs exactly as
 * the chat-session-access route calls them (see src/durable-objects/project-data/index.ts
 * ~lines 1460-1566, `createSessionAccessGrant` / `revokeSessionAccessGrant`).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import * as projectDataService from '../../src/services/project-data';

const testEnv = env as unknown as Env;

function getStub(projectId: string): DurableObjectStub<ProjectData> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
}

type Broadcast = { type?: string; payload?: Record<string, unknown> } & Record<string, unknown>;

async function subscribe(stub: DurableObjectStub<ProjectData>, chatSessionId: string) {
  const response = await stub.fetch(`https://do/ws?sessionId=${chatSessionId}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  const messages: Broadcast[] = [];
  ws.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data as string) as Broadcast);
  });
  return { ws, messages };
}

function accessChangedEvents(messages: Broadcast[]): Record<string, unknown>[] {
  return messages
    .filter((m) => m.type === 'session.access.changed')
    .map((m) => (m.payload ?? m) as Record<string, unknown>);
}

function sessionUpdates(messages: Broadcast[]): Record<string, unknown>[] {
  return messages
    .filter((m) => m.type === 'session.updated')
    .map((m) => (m.payload ?? m) as Record<string, unknown>);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function ownedSession(
  projectId: string,
  topic: string,
  ownerUserId: string
): Promise<string> {
  return projectDataService.createSession(testEnv, projectId, null, topic, null, ownerUserId);
}

describe('session access grant/revoke pushes session.access.changed', () => {
  it('delivers granted then revoked to a socket subscribed to that session', async () => {
    const projectId = `proj-access-broadcast-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    const ownerUserId = `owner-${crypto.randomUUID()}`;
    const granteeUserId = `grantee-${crypto.randomUUID()}`;
    const chatSessionId = await ownedSession(projectId, 'Shared access broadcast', ownerUserId);
    const { ws, messages } = await subscribe(stub, chatSessionId);

    const created = await stub.createSessionAccessGrant({
      sessionId: chatSessionId,
      granteeUserId,
      grantedByUserId: ownerUserId,
      maxActiveGrants: 5,
    });
    expect(created.result.status).toBe('created');
    await settle();

    expect(accessChangedEvents(messages)).toContainEqual(
      expect.objectContaining({ sessionId: chatSessionId, reason: 'granted' })
    );

    const revoked = await stub.revokeSessionAccessGrant({
      sessionId: chatSessionId,
      granteeUserId,
      actorUserId: ownerUserId,
    });
    expect(revoked.result.status).toBe('revoked');
    await settle();

    expect(accessChangedEvents(messages)).toContainEqual(
      expect.objectContaining({ sessionId: chatSessionId, reason: 'revoked' })
    );
    ws.close();
  });

  it('does not leak session.access.changed to a socket subscribed to another session (scoping control)', async () => {
    const projectId = `proj-access-broadcast-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    const ownerUserId = `owner-${crypto.randomUUID()}`;
    const granteeUserId = `grantee-${crypto.randomUUID()}`;
    const targetSessionId = await ownedSession(projectId, 'Target', ownerUserId);
    const otherSessionId = await stub.createSession(null, 'Bystander');
    const other = await subscribe(stub, otherSessionId);

    const created = await stub.createSessionAccessGrant({
      sessionId: targetSessionId,
      granteeUserId,
      grantedByUserId: ownerUserId,
      maxActiveGrants: 5,
    });
    expect(created.result.status).toBe('created');
    await settle();

    expect(
      accessChangedEvents(other.messages).some((event) => event.sessionId === targetSessionId)
    ).toBe(false);
    // Liveness: the bystander socket is open and does receive its own events.
    await stub.updateSessionTopic(otherSessionId, 'Bystander renamed');
    await settle();
    expect(sessionUpdates(other.messages)).toContainEqual(
      expect.objectContaining({ sessionId: otherSessionId, topic: 'Bystander renamed' })
    );
    other.ws.close();
  });

  it('does not broadcast on a no-op revoke (not_granted)', async () => {
    const projectId = `proj-access-broadcast-${crypto.randomUUID()}`;
    const stub = getStub(projectId);
    const ownerUserId = `owner-${crypto.randomUUID()}`;
    const chatSessionId = await ownedSession(projectId, 'No-op revoke', ownerUserId);
    const { ws, messages } = await subscribe(stub, chatSessionId);

    const revoked = await stub.revokeSessionAccessGrant({
      sessionId: chatSessionId,
      granteeUserId: `nobody-${crypto.randomUUID()}`,
      actorUserId: ownerUserId,
    });
    expect(revoked.result.status).toBe('not_granted');
    await settle();

    expect(accessChangedEvents(messages)).toEqual([]);
    // Liveness: the socket is still open and does receive other session events.
    await stub.updateSessionTopic(chatSessionId, 'Renamed after no-op revoke');
    await settle();
    expect(sessionUpdates(messages)).toContainEqual(
      expect.objectContaining({ sessionId: chatSessionId, topic: 'Renamed after no-op revoke' })
    );
    ws.close();
  });
});
