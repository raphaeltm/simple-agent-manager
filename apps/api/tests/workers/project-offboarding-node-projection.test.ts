import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { enumerateOffboardingResources } from '../../src/services/project-offboarding-preview-resources';
import { seedInstallation, seedNode, seedProject, seedUser, seedWorkspace } from './helpers/seed-d1';

it('enumerates attributed workspace and deployment resources within D1 result-column limits', async () => {
  const prefix = `offboarding-projection-${Date.now()}`;
  const userId = `${prefix}-user`;
  const projectId = `${prefix}-project`;
  const workspaceNodeId = `${prefix}-workspace-node`;
  const deploymentNodeId = `${prefix}-deployment-node`;
  const platformNodeId = `${prefix}-platform-node`;
  await seedUser(userId);
  await seedInstallation(`${prefix}-installation`, userId);
  await seedProject(projectId, userId, `${prefix}-installation`);
  for (const nodeId of [workspaceNodeId, deploymentNodeId, platformNodeId]) {
    await seedNode(nodeId, userId);
    await env.DATABASE.prepare(`UPDATE nodes SET cloud_provider = 'hetzner',
      credential_attribution_user_id = ?, credential_attribution_project_id = ?,
      credential_attribution_source = ?, node_role = ? WHERE id = ?`)
      .bind(userId, projectId, nodeId === platformNodeId ? 'platform' : 'user',
        nodeId === workspaceNodeId ? 'workspace' : 'deployment', nodeId).run();
  }
  await seedWorkspace(`${prefix}-workspace`, workspaceNodeId, userId, { projectId });
  for (const [id, nodeId] of [['owned', deploymentNodeId], ['platform', platformNodeId]]) {
    await env.DATABASE.prepare(`INSERT INTO deployment_environments
      (id, project_id, name, status, node_id, requires_volumes)
      VALUES (?, ?, ?, 'active', ?, 1)`)
      .bind(`${prefix}-${id}`, projectId, `${id} deployment`, nodeId).run();
  }
  const db = drizzle(env.DATABASE, { schema });
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  expect(project).toBeDefined();
  const resources = await enumerateOffboardingResources({
    db, project: project!, memberUserId: userId, defaultAgentType: 'openai-codex',
  });
  expect(resources).toHaveLength(2);
  expect(resources.find((resource) => resource.resourceKind === 'node')).toMatchObject({
    resourceId: workspaceNodeId, title: `node-${workspaceNodeId}`,
    credentialSourceBefore: 'user', attributionUserIdBefore: userId,
    attributionProjectIdBefore: projectId, recommendedAction: 'break_and_flag',
    details: { nodeRole: 'workspace', cloudProvider: 'hetzner', workspaceId: `${prefix}-workspace` },
  });
  expect(resources.find((resource) => resource.resourceKind === 'deployment_environment')).toMatchObject({
    resourceId: `${prefix}-owned`, title: 'owned deployment', subtitle: 'active',
    credentialSourceBefore: 'user', attributionUserIdBefore: userId,
    attributionProjectIdBefore: projectId, recommendedAction: 'break_and_flag',
    blocksRemoval: true,
    details: { nodeId: deploymentNodeId, nodeStatus: 'running', requiresVolumes: true },
  });
});
