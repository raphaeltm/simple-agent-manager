import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { expect } from 'vitest';

import { runProjectEventWakeMaterializationBatch } from '../../../src/durable-objects/project-data/project-events';
import type { Env } from '../../../src/env';
import { storeMcpToken } from '../../../src/services/mcp-token';
import type { ProjectDataTestDouble } from '../support/expected-error-doubles';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './seed-d1';

export const testEnv = env as unknown as Env & Record<string, string | undefined>;

export type ToolReply = {
  error?: { code: number; message: string; data?: Record<string, unknown> };
  result?: { content: Array<{ text: string }> };
};

export type TestAgent = {
  label: string;
  userId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string;
  agentSessionId: string;
  tool: (name: string, args: Record<string, unknown>) => Promise<ToolReply>;
};

export function projectStub(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  return env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
}

/** Seed one running task agent (task, chat, workspace, agent session, MCP token). */
export async function seedTaskAgent(
  projectId: string,
  userId: string,
  nodeId: string,
  label: string
): Promise<TestAgent> {
  const id = `${label}-${crypto.randomUUID()}`;
  const taskId = `t-${id}`;
  const workspaceId = `w-${id}`;
  const agentSessionId = `a-${id}`;
  const stub = projectStub(projectId);
  await stub.ensureProjectId(projectId);
  const sessionId = await stub.createSession(workspaceId, `Agent ${label}`, taskId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: sessionId });
  await seedTask(taskId, projectId, userId, {
    workspaceId,
    chatSessionId: sessionId,
    status: 'in_progress',
  });
  await seedAgentSession(agentSessionId, workspaceId, userId);
  const token = crypto.randomUUID();
  await storeMcpToken(env.KV, token, {
    projectId,
    userId,
    taskId,
    workspaceId,
    agentSessionId,
    chatSessionId: sessionId,
    createdAt: new Date().toISOString(),
  });
  const tool = async (name: string, args: Record<string, unknown>) => {
    const response = await SELF.fetch('https://api.test.example.com/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${label}-${name}`,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    return response.json<ToolReply>();
  };
  return { label, userId, taskId, workspaceId, sessionId, agentSessionId, tool };
}

/**
 * One project with agent A (owner) and agent B (a maintainer, a different user),
 * plus agent C in an unrelated project owned by the same owner.
 */
export async function twoAgentProject() {
  const id = crypto.randomUUID();
  const ownerId = `owner-${id}`;
  const memberId = `member-${id}`;
  const projectId = `p-${id}`;
  const otherProjectId = `p2-${id}`;
  await seedUser(ownerId);
  await seedUser(memberId);
  await seedInstallation(id, ownerId, { installationIdValue: id, accountName: ownerId });
  await seedProject(projectId, ownerId, id);
  await seedProject(otherProjectId, ownerId, id);
  await env.DATABASE.prepare(
    `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
     VALUES (?, ?, 'maintainer', 'active', datetime('now'), datetime('now'))`
  )
    .bind(projectId, memberId)
    .run();
  await seedNode(`n-owner-${id}`, ownerId);
  await seedNode(`n-member-${id}`, memberId);
  const a = await seedTaskAgent(projectId, ownerId, `n-owner-${id}`, 'a');
  const b = await seedTaskAgent(projectId, memberId, `n-member-${id}`, 'b');
  const c = await seedTaskAgent(otherProjectId, ownerId, `n-owner-${id}`, 'c');
  return {
    projectId,
    otherProjectId,
    ownerId,
    memberId,
    ownerNodeId: `n-owner-${id}`,
    a,
    b,
    c,
    stub: projectStub(projectId),
  };
}

/** Parse a successful MCP tool reply body. */
export function okBody<T>(reply: ToolReply): T {
  expect(reply.error).toBeUndefined();
  return JSON.parse(reply.result!.content[0]!.text) as T;
}

/**
 * Run with the preview and its prerequisites enabled, then restore the env.
 * This mutates the shared cloudflare:test env, so tests using it must not run
 * with test.concurrent.
 */
export async function withAgentMessageChannels<T>(
  fn: () => Promise<T>,
  overrides: Record<string, string> = {}
): Promise<T> {
  const settings = {
    AGENT_MESSAGE_CHANNELS_ENABLED: 'true',
    PROJECT_EVENT_WAKE_ENABLED: 'true',
    ...overrides,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(settings)) {
    previous.set(key, testEnv[key]);
    testEnv[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete testEnv[key];
      else testEnv[key] = value;
    }
  }
}

export function sqlRows<T extends Record<string, unknown>>(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  query: string,
  ...params: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec(query, ...params).toArray()
  ) as Promise<T[]>;
}

/** Materialize every due wake batch the way the ProjectData alarm does. */
export async function materializeWakes(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  projectId: string
): Promise<void> {
  for (let pass = 0; pass < 10; pass++) {
    const result = await runInDurableObject(stub, (_instance, state) =>
      state.storage.transactionSync(() =>
        runProjectEventWakeMaterializationBatch(
          state.storage.sql,
          { ...testEnv, PROJECT_EVENT_WAKE_ENABLED: 'true' },
          projectId,
          Date.now(),
          { ignoreSchedulerCheckpoint: true }
        )
      )
    );
    if (result.status !== 'materialized') return;
  }
}

export type ManagedSubscriptionRow = {
  id: string;
  owner_id: string;
  target_session_id: string;
  lifecycle_state: string;
  filter_json: string;
};

export function managedSubscriptions(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  state: 'active' | 'any' = 'active'
): Promise<ManagedSubscriptionRow[]> {
  return sqlRows<ManagedSubscriptionRow>(
    stub,
    `SELECT id, owner_id, target_session_id, lifecycle_state, filter_json
     FROM project_event_subscriptions
     WHERE idempotency_key LIKE 'sam-agent-message:%' AND (? = 'any' OR lifecycle_state = 'active')
     ORDER BY created_at, id`,
    state
  );
}

export function eventMatches(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  eventId: string
): Promise<Array<{ subscription_id: string; target_session_id: string; state: string }>> {
  return sqlRows(
    stub,
    `SELECT m.subscription_id, s.target_session_id, m.state
     FROM project_event_matches m JOIN project_event_subscriptions s ON s.id = m.subscription_id
     WHERE m.event_id = ? ORDER BY s.target_session_id`,
    eventId
  );
}

/**
 * Override env values seen by one ProjectData Durable Object instance (limits are
 * read there), then restore them. Same no-test.concurrent caveat as above.
 */
export async function withProjectDataEnv<T>(
  stub: DurableObjectStub<ProjectDataTestDouble>,
  overrides: Record<string, string>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = await runInDurableObject(stub, (instance) => {
    const doEnv = (instance as unknown as { env: Record<string, string | undefined> }).env;
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, doEnv[key]]));
    Object.assign(doEnv, overrides);
    return saved;
  });
  try {
    return await fn();
  } finally {
    await runInDurableObject(stub, (instance) => {
      const doEnv = (instance as unknown as { env: Record<string, string | undefined> }).env;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete doEnv[key];
        else doEnv[key] = value;
      }
    });
  }
}

export type ChannelReceipt = {
  accepted: true;
  delivered: false;
  deliveryState?: string;
  queued?: boolean;
  messageId: string;
  transport: 'agent_message_channel';
  channel: string;
  eventId: string;
  sequence: number;
  replayed: boolean;
  idempotencyKey: string;
  recipient: { taskId: string; subscriptionMatched: boolean };
};

export type InboxRow = {
  id: string;
  target_session_id: string;
  source_kind: string;
  sender_type: string;
  content: string;
  metadata: string | null;
};

export const inboxRows = (stub: Parameters<typeof sqlRows>[0]) =>
  sqlRows<InboxRow>(
    stub,
    `SELECT id, target_session_id, source_kind, sender_type, content, metadata
     FROM session_inbox ORDER BY created_at, id`
  );

export const channelRows = (stub: Parameters<typeof sqlRows>[0]) =>
  sqlRows<{ name: string; lifetime_count: number }>(
    stub,
    'SELECT name, lifetime_count FROM project_event_channels ORDER BY name'
  );
