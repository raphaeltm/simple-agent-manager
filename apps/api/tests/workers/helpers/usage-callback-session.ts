/**
 * A running Claude Code session wired the way the usage callback requires: D1 user, project,
 * node, workspace and agent session with server-side credential attribution, plus the bound ACP
 * session in the project's ProjectData Durable Object and a real callback token. Shared by the
 * usage-callback vertical slices (credential limits, run usage).
 */
import { env } from 'cloudflare:test';

import type { Env } from '../../../src/env';
import { signCallbackToken } from '../../../src/services/jwt';
import * as projectDataService from '../../../src/services/project-data';
import {
  seedAgentSession,
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './seed-d1';

const testEnv = env as unknown as Env;

export async function seedClaudeSession(suffix: string, credentialReference: string) {
  const userId = `user-usage-${suffix}`;
  const installationId = `inst-usage-${suffix}`;
  const projectId = `project-usage-${suffix}`;
  const nodeId = `node-usage-${suffix}`;
  const workspaceId = `ws-usage-${suffix}`;
  const agentSessionId = `as-usage-${suffix}`;

  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);
  const chatSessionId = await projectDataService.createSession(
    testEnv,
    projectId,
    workspaceId,
    'Claude usage limits vertical slice'
  );
  await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId, status: 'running' });
  await seedAgentSession(agentSessionId, workspaceId, userId, {
    status: 'running',
    agentType: 'claude-code',
  });
  // Server-side attribution the agent-key route records when it hands the VM agent
  // a Claude Max token from a backfilled credential.
  await testEnv.DATABASE.prepare(
    `UPDATE agent_sessions
        SET agent_credential_reference = ?, agent_credential_source = 'user',
            agent_credential_provider = 'agent', agent_provider_mode = 'direct',
            agent_credential_generation = 1
      WHERE id = ?`
  )
    .bind(credentialReference, agentSessionId)
    .run();

  await projectDataService.createAcpSession(
    testEnv,
    projectId,
    chatSessionId,
    'Report Claude usage windows',
    'claude-code',
    null,
    0,
    agentSessionId
  );
  await projectDataService.transitionAcpSession(testEnv, projectId, agentSessionId, 'assigned', {
    actorType: 'system',
    workspaceId,
    nodeId,
  });
  await projectDataService.transitionAcpSession(testEnv, projectId, agentSessionId, 'running', {
    actorType: 'vm-agent',
    actorId: nodeId,
  });

  return {
    userId,
    projectId,
    nodeId,
    workspaceId,
    chatSessionId,
    agentSessionId,
    callbackToken: await signCallbackToken(workspaceId, testEnv, { callbackGeneration: null }),
  };
}
