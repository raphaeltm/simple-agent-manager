import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import {
  resolveLiveAgentSessionForChat,
  resolveLiveWorkspaceForSession,
} from '../../src/routes/chat-workspace-resolver';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const PREFIX = `instant-recovery-${Date.now()}`;
const USER_ID = `${PREFIX}-user`;
const INSTALLATION_ID = `${PREFIX}-installation`;
const PROJECT_ID = `${PREFIX}-project`;
const CONTAINER_NODE_ID = `${PREFIX}-container-node`;
const VM_NODE_ID = `${PREFIX}-vm-node`;
const CONTAINER_WORKSPACE_ID = `${PREFIX}-container-workspace`;
const VM_WORKSPACE_ID = `${PREFIX}-vm-workspace`;
const CONTAINER_CHAT_ID = `${PREFIX}-container-chat`;
const VM_CHAT_ID = `${PREFIX}-vm-chat`;
const AGENT_SESSION_ID = `${PREFIX}-agent-session`;

describe('Instant recovery resolver with real D1 state', () => {
  beforeAll(async () => {
    await seedUser(USER_ID);
    await seedInstallation(INSTALLATION_ID, USER_ID, {
      installationIdValue: `${PREFIX}-external`,
    });
    await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
    await seedNode(CONTAINER_NODE_ID, USER_ID, { status: 'error', healthStatus: 'unhealthy' });
    await seedNode(VM_NODE_ID, USER_ID, { status: 'error', healthStatus: 'unhealthy' });
    await env.DATABASE.prepare(`UPDATE nodes SET runtime = 'cf-container' WHERE id = ?`)
      .bind(CONTAINER_NODE_ID)
      .run();
    await seedWorkspace(CONTAINER_WORKSPACE_ID, CONTAINER_NODE_ID, USER_ID, {
      projectId: PROJECT_ID,
      status: 'error',
      chatSessionId: CONTAINER_CHAT_ID,
    });
    await seedWorkspace(VM_WORKSPACE_ID, VM_NODE_ID, USER_ID, {
      projectId: PROJECT_ID,
      status: 'error',
      chatSessionId: VM_CHAT_ID,
    });
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions
         (id, workspace_id, user_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, ?, 'error', 'codex', datetime('now'), datetime('now'))`
    )
      .bind(AGENT_SESSION_ID, CONTAINER_WORKSPACE_ID, USER_ID)
      .run();
  });

  function db() {
    return drizzle(env.DATABASE, { schema });
  }

  it('allows a cf-container legacy error row to reach the Durable Object recovery path', async () => {
    const resolved = await resolveLiveAgentSessionForChat(db(), {
      projectId: PROJECT_ID,
      sessionId: CONTAINER_CHAT_ID,
      userId: USER_ID,
    });

    expect(resolved).toEqual({
      workspace: {
        id: CONTAINER_WORKSPACE_ID,
        nodeId: CONTAINER_NODE_ID,
        nodeStatus: 'error',
        nodeRuntime: 'cf-container',
      },
      agentSession: { id: AGENT_SESSION_ID },
    });
  });

  it('does not weaken the dead-node guard for a VM workspace in error', async () => {
    const resolved = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_ID,
      sessionId: VM_CHAT_ID,
      userId: USER_ID,
    });

    expect(resolved).toBeNull();
  });

  it('keeps project and user ownership predicates on the recovery path', async () => {
    const resolved = await resolveLiveWorkspaceForSession(db(), {
      projectId: `${PROJECT_ID}-other`,
      sessionId: CONTAINER_CHAT_ID,
      userId: USER_ID,
    });

    expect(resolved).toBeNull();
  });
});
