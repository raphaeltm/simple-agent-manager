/**
 * A chat page opened before its agent session exists only learns
 * `agentSessionId` from the initial session fetch. The usage-limit chip, the
 * ACP id in the header, and resume/recovery all key on it, so the DO must push
 * it the moment the ACP session is registered.
 *
 * Enters through the real trigger (rule 62): a browser-style WebSocket
 * subscription on the chat session, then `createAcpSession` exactly as the
 * chat-start and task-runner paths call it.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';

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

function sessionUpdates(messages: Broadcast[]): Record<string, unknown>[] {
  return messages
    .filter((m) => m.type === 'session.updated')
    .map((m) => (m.payload ?? m) as Record<string, unknown>);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('createAcpSession pushes agentSessionId to the open chat page', () => {
  it('a socket subscribed to the chat session receives session.updated with the ACP id', async () => {
    const stub = getStub(`proj-acp-broadcast-${crypto.randomUUID()}`);
    const chatSessionId = await stub.createSession(null, 'Usage chip reactivity');
    const { ws, messages } = await subscribe(stub, chatSessionId);

    const acp = await stub.createAcpSession({
      chatSessionId,
      initialPrompt: 'Reply with one sentence.',
      agentType: 'openai-codex',
    });
    await settle();

    const updates = sessionUpdates(messages);
    expect(updates).toContainEqual(
      expect.objectContaining({ sessionId: chatSessionId, agentSessionId: acp.id })
    );
    ws.close();
  });

  it('does not leak the ACP id to a socket subscribed to another chat session (scoping control)', async () => {
    const stub = getStub(`proj-acp-broadcast-${crypto.randomUUID()}`);
    const chatSessionId = await stub.createSession(null, 'Target');
    const otherChatSessionId = await stub.createSession(null, 'Bystander');
    const other = await subscribe(stub, otherChatSessionId);

    const acp = await stub.createAcpSession({
      chatSessionId,
      initialPrompt: 'Reply with one sentence.',
      agentType: 'openai-codex',
    });
    await settle();

    expect(sessionUpdates(other.messages).some((u) => u.agentSessionId === acp.id)).toBe(false);
    // Liveness: the bystander socket is open and does receive its own events.
    await stub.updateSessionTopic(otherChatSessionId, 'Bystander renamed');
    await settle();
    expect(sessionUpdates(other.messages)).toContainEqual(
      expect.objectContaining({ sessionId: otherChatSessionId, topic: 'Bystander renamed' })
    );
    other.ws.close();
  });
});
