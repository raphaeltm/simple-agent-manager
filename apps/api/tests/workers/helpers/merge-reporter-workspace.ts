import { projectDataPorts } from '@simple-agent-manager/project-data/internal/do/ports';
import { env, SELF } from 'cloudflare:test';
import { expect, vi } from 'vitest';

import { signCurrentWorkspaceCallbackToken } from '../../../src/services/jwt';
import { reserveWorkspacePlacement } from '../../../src/services/workspace-placement';
import { seedInstallation, seedNode, seedProject, seedUser } from './seed-d1';

/**
 * A project with one chat session bound to a real reserved workspace, a current callback token
 * and merging switched on, so chunks can be delivered through the reporter callback route.
 */

export async function startup() {
  const prefix = `merge-startup-${crypto.randomUUID()}`;
  const user = `${prefix}-user`;
  const project = `${prefix}-project`;
  const installation = `${prefix}-installation`;
  const node = `${prefix}-node`;
  const workspace = `${prefix}-workspace`;
  const now = new Date().toISOString();
  await seedUser(user);
  await seedInstallation(installation, user);
  await seedProject(project, user, installation);
  // A real, registered VM avoids cloud-provider fixture credentials. Hardware
  // observation and final admission still run through the production SQL.
  await seedNode(node, user, { status: 'running', nodeClass: 'user-owned' });
  await env.DATABASE.prepare(
    `UPDATE nodes SET agent_ready_at = ?, last_heartbeat_at = ?,
       observed_hardware_source = 'observed',
       observed_provider_instance_vcpu_count = 2,
       observed_provider_instance_memory_mb = 4096,
       observed_provider_instance_disk_gb = 40,
       last_metrics = '{"cpuLoadAvg1":0,"memoryPercent":10,"diskPercent":10}'
     WHERE id = ?`
  )
    .bind(now, now, node)
    .run();
  const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(project));
  await stub.ensureProjectId(project);
  const session = await stub.createSession(workspace, 'Reporter startup regression');
  // This is TaskRunner's actual workspace-creation writer. Never seed or
  // overwrite callback_generation: the test must consume its normal default.
  expect(
    await reserveWorkspacePlacement(
      env.DATABASE,
      {
        id: workspace,
        nodeId: node,
        projectId: project,
        userId: user,
        installationId: installation,
        name: workspace,
        displayName: workspace,
        normalizedDisplayName: workspace,
        repository: `test-org/${project}`,
        branch: 'main',
        chatSessionId: session,
        vmSize: 'small',
        vmLocation: 'nbg1',
        workspaceProfile: 'lightweight',
        devcontainerConfigName: null,
        agentProfileHint: null,
        authorityNodeClass: 'user-owned',
        createdAt: now,
        resolvedReservation: {
          cpuMillis: 1000,
          memoryMb: 1024,
          diskMb: 1024,
          exclusiveNode: false,
          source: 'platform',
          sourceId: 'platform',
          version: 1,
        },
      },
      {
        cpuShareBudgetPercent: 100,
        hostMemoryReserveMb: 0,
        diskPressureThresholdPercent: 90,
        metricsTtlMs: 180000,
        cpuThresholdPercent: 90,
        memoryThresholdPercent: 90,
        cpuScoreWeightPercent: 40,
        memoryScoreWeightPercent: 60,
      }
    )
  ).toBe(true);
  const identity = await env.DATABASE.prepare(
    'SELECT callback_generation FROM workspaces WHERE id = ?'
  )
    .bind(workspace)
    .first<{ callback_generation: string | null }>();
  expect(identity).toEqual({ callback_generation: null });
  vi.spyOn(projectDataPorts().operations, 'messageMergeConfig').mockResolvedValue({
    enabled: true,
    maxRowBytes: 65536,
    recentIds: 200,
  });
  const token = await signCurrentWorkspaceCallbackToken(workspace, env);
  return {
    prefix,
    user,
    workspace,
    project,
    stub,
    session,
    token,
    now,
    incarnation: crypto.randomUUID(),
  };
}

export type Startup = Awaited<ReturnType<typeof startup>>;
export function chunks(f: Startup, contents: string[], sequence = 1, tag = '') {
  return contents.map((content, index) => ({
    messageId: `${f.prefix}-${tag}-chunk-${index}`,
    sessionId: f.session,
    role: 'assistant',
    content,
    timestamp: f.now,
    sequence: sequence + index,
  }));
}
export async function deliver(
  f: Startup,
  messages: ReturnType<typeof chunks>,
  incarnation: string | null = f.incarnation,
  token = f.token
) {
  const response = await SELF.fetch(
    `https://api.test.example.com/api/workspaces/${f.workspace}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(incarnation === null ? {} : { 'X-SAM-Outbox-Incarnation': incarnation }),
      },
      body: JSON.stringify({ messages }),
    }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as { persisted: number; duplicates: number };
}
export async function contents(f: Startup) {
  return (
    await f.stub.getMessages(f.session, 1000, null, null, undefined, false, 'asc')
  ).messages.map(({ content }) => content);
}
