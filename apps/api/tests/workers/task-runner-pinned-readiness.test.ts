/** Pinned-node boot races through TaskRunner.start(), alarms, authenticated callbacks and D1. */
import {
  DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS,
  DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type {
  StartTaskInput,
  TaskRunner,
  TaskRunnerState,
} from '../../src/durable-objects/task-runner';
import { encrypt } from '../../src/services/encryption';
import { signNodeCallbackToken } from '../../src/services/jwt';
import { seedInstallation, seedNode, seedProject, seedTask, seedUser } from './helpers/seed-d1';

const REQUIRED_VERSION = 'vm-agent-pinned-readiness-build';

type Fixture = {
  nodeId: string;
  taskId: string;
  userId: string;
  stub: DurableObjectStub<TaskRunner>;
};

async function fixture(status = 'creating', version: string | null = null): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const userId = `pinned-user-${suffix}`;
  const projectId = `pinned-project-${suffix}`;
  const installationId = `pinned-installation-${suffix}`;
  const nodeId = `pinned-node-${suffix}`;
  const taskId = `pinned-task-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  // This is a legacy unpooled managed node: no default pool is selected.
  const token = await encrypt('pinned-readiness-test-cloud-token', env.ENCRYPTION_KEY);
  await env.DATABASE.prepare(
    `INSERT INTO credentials
       (id, user_id, provider, credential_type, credential_kind, is_active, encrypted_token, iv, created_at, updated_at)
     VALUES (?, ?, 'hetzner', 'cloud-provider', 'api-key', 1, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(`pinned-credential-${suffix}`, userId, token.ciphertext, token.iv)
    .run();
  await seedNode(nodeId, userId, { status });
  await env.DATABASE.prepare(
    `UPDATE nodes SET runtime = 'vm', node_role = 'workspace', cloud_provider = 'hetzner',
       provider_instance_id = ?, provider_instance_type = 'cx23',
       provider_instance_vcpu_count = 2, provider_instance_memory_mb = 4096,
       provider_instance_disk_gb = 40, observed_hardware_source = 'observed',
       observed_provider_instance_type = 'cx23', observed_provider_instance_vcpu_count = 2,
       observed_provider_instance_memory_mb = 4096, observed_provider_instance_disk_gb = 40,
       agent_version = ?, agent_ready_at = NULL WHERE id = ?`
  )
    .bind(`server-${suffix}`, version, nodeId)
    .run();
  await seedTask(taskId, projectId, userId, { status: 'queued' });
  const input: StartTaskInput = {
    taskId,
    projectId,
    userId,
    config: {
      vmSize: 'small',
      vmLocation: 'nbg1',
      branch: 'main',
      defaultBranch: 'main',
      preferredNodeId: nodeId,
      userName: 'Pinned readiness test',
      userEmail: 'pinned@test.com',
      githubId: null,
      taskTitle: 'Wait for the pinned node',
      taskDescription: null,
      repository: `test-org/${projectId}`,
      installationId,
      outputBranch: null,
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: 'openai-codex',
      workspaceProfile: 'full',
      devcontainerConfigName: null,
      cloudProvider: null,
      credentialAttributionUserId: userId,
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      attachments: null,
      resolvedReservation: {
        cpuMillis: 500,
        memoryMb: 512,
        diskMb: 1024,
        exclusiveNode: false,
        source: 'task',
        sourceId: taskId,
        version: 1,
      },
    },
  };
  const stub = env.TASK_RUNNER.get(
    env.TASK_RUNNER.idFromName(taskId)
  ) as DurableObjectStub<TaskRunner>;
  await runInDurableObject(stub, async (instance) => {
    // Configure only this runner; all polling/deadline defaults use the real resolver.
    instance.env = { ...instance.env, VM_AGENT_REQUIRED_VERSION: REQUIRED_VERSION };
    await instance.start(input);
    await instance.ctx.storage.deleteAlarm();
  });
  return { nodeId, taskId, userId, stub };
}

async function alarm(f: Fixture): Promise<{ state: TaskRunnerState; nextAlarm: number | null }> {
  return runInDurableObject(f.stub, async (instance) => {
    await instance.alarm();
    const state = await instance.ctx.storage.get<TaskRunnerState>('state');
    if (!state) throw new Error('TaskRunner state missing after start');
    const nextAlarm = await instance.ctx.storage.getAlarm();
    // Tests drive each event explicitly, before the runtime can consume the next alarm.
    await instance.ctx.storage.deleteAlarm();
    return { state, nextAlarm };
  });
}

async function task(f: Fixture) {
  return env.DATABASE.prepare(
    'SELECT status, workspace_id, auto_provisioned_node_id, error_message FROM tasks WHERE id = ?'
  )
    .bind(f.taskId)
    .first();
}

async function assertNoWorkspace(f: Fixture, nodeStatus: string): Promise<void> {
  expect(await task(f)).toMatchObject({ workspace_id: null, auto_provisioned_node_id: null });
  expect(
    await env.DATABASE.prepare('SELECT COUNT(*) AS count FROM workspaces WHERE node_id = ?')
      .bind(f.nodeId)
      .first()
  ).toEqual({ count: 0 });
  expect(
    await env.DATABASE.prepare('SELECT status FROM nodes WHERE id = ?').bind(f.nodeId).first()
  ).toEqual({ status: nodeStatus });
}

async function callback(f: Fixture, kind: 'heartbeat' | 'ready', agentVersion = REQUIRED_VERSION) {
  const jwt = await signNodeCallbackToken(f.nodeId, env, { callbackGeneration: null });
  const response = await SELF.fetch(`https://api.test.example.com/api/nodes/${f.nodeId}/${kind}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentVersion,
      metrics: { cpuLoadAvg1: 0, memoryPercent: 15, diskPercent: 20 },
    }),
  });
  expect(response.status, await response.text()).toBe(200);
}

async function assertWaiting(f: Fixture, nodeStatus: string) {
  const before = Date.now();
  const result = await alarm(f);
  expect(result.state).toMatchObject({
    currentStep: 'node_selection',
    completed: false,
    retryCount: 0,
    stepResults: { nodeId: null, autoProvisioned: false, workspaceId: null },
  });
  expect(result.state.agentReadyStartedAt).toEqual(expect.any(Number));
  expect(result.nextAlarm).toBeGreaterThanOrEqual(before);
  expect(result.nextAlarm).toBeLessThanOrEqual(
    Date.now() + DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS
  );
  expect(await task(f)).toMatchObject({ status: 'queued', error_message: null });
  await assertNoWorkspace(f, nodeStatus);
  return result;
}

describe('TaskRunner pinned node readiness', () => {
  it.each(['creating', 'running'])(
    'waits for a %s pinned node with no version, then allocates after the matching ready callback',
    async (initialStatus) => {
      const f = await fixture(initialStatus);
      const first = await assertWaiting(f, initialStatus);
      const repeated = await assertWaiting(f, initialStatus);
      expect(repeated.state.agentReadyStartedAt).toBe(first.state.agentReadyStartedAt);

      await callback(f, 'heartbeat');
      expect(
        await env.DATABASE.prepare('SELECT agent_version, agent_ready_at FROM nodes WHERE id = ?')
          .bind(f.nodeId)
          .first()
      ).toEqual({ agent_version: REQUIRED_VERSION, agent_ready_at: null });
      // A heartbeat carrying the right binary is not the /ready signal.
      const heartbeatOnly = await assertWaiting(f, initialStatus);
      expect(heartbeatOnly.state.agentReadyStartedAt).toBe(first.state.agentReadyStartedAt);

      await callback(f, 'ready');
      const selected = await alarm(f);
      expect(selected.state).toMatchObject({
        currentStep: 'workspace_creation',
        completed: false,
        stepResults: { nodeId: f.nodeId, autoProvisioned: false, workspaceId: null },
      });
      const allocated = await alarm(f);
      expect(allocated.state).toMatchObject({
        currentStep: 'workspace_dispatch',
        completed: false,
      });
      expect(allocated.state.stepResults.workspaceId).toEqual(expect.any(String));
      expect(await task(f)).toMatchObject({
        status: 'delegated',
        workspace_id: allocated.state.stepResults.workspaceId,
        auto_provisioned_node_id: null,
        error_message: null,
      });
      expect(
        await env.DATABASE.prepare('SELECT node_id, status FROM workspaces WHERE id = ?')
          .bind(allocated.state.stepResults.workspaceId)
          .first()
      ).toEqual({ node_id: f.nodeId, status: 'creating' });
    }
  );

  it.each(['creating', 'running'])(
    'refuses a reported different build on a %s node',
    async (status) => {
      const f = await fixture(status, 'different-agent-build');
      const result = await alarm(f);
      expect(result.state.completed).toBe(true);
      expect(result.nextAlarm).toBeNull();
      expect(await task(f)).toMatchObject({
        status: 'failed',
        error_message: 'Specified node agent build differs from the required VM agent build',
      });
      await assertNoWorkspace(f, status);
    }
  );

  it.each([null, REQUIRED_VERSION])(
    'fails with the actual not-ready condition at deadline (version %s)',
    async (version) => {
      const f = await fixture('running', version);
      await assertWaiting(f, 'running');
      await runInDurableObject(f.stub, async (instance) => {
        const state = await instance.ctx.storage.get<TaskRunnerState>('state');
        if (!state) throw new Error('Missing runner state');
        // Advance the persisted wait age, keeping the configured timeout's real default.
        state.agentReadyStartedAt = Date.now() - DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS;
        await instance.ctx.storage.put('state', state);
      });
      const result = await alarm(f);
      expect(result.state.completed).toBe(true);
      expect(result.nextAlarm).toBeNull();
      expect(await task(f)).toMatchObject({
        status: 'failed',
        error_message: `Specified node not ready by deadline: ${
          version ? 'agent has not become ready yet' : 'agent has not reported a version yet'
        }`,
      });
      await assertNoWorkspace(f, 'running');
    }
  );

  it('uses the existing configurable timeout and schedules no later than its deadline', async () => {
    const f = await fixture();
    await runInDurableObject(f.stub, async (instance) => {
      instance.env = {
        ...instance.env,
        TASK_RUNNER_AGENT_READY_TIMEOUT_MS: '60000',
        TASK_RUNNER_AGENT_POLL_INTERVAL_MS: '120000',
      };
    });
    const waiting = await alarm(f);
    expect(waiting.state.completed).toBe(false);
    expect(waiting.nextAlarm).toBe(waiting.state.agentReadyStartedAt! + 60000);
    await runInDurableObject(f.stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('Missing runner state');
      state.agentReadyStartedAt = Date.now() - 60000;
      await instance.ctx.storage.put('state', state);
    });
    expect((await alarm(f)).state.completed).toBe(true);
    expect(await task(f)).toMatchObject({
      status: 'failed',
      error_message: expect.stringContaining('not ready by deadline'),
    });
    await assertNoWorkspace(f, 'creating');
  });

  it('refuses a different version reported while the pinned task is already waiting', async () => {
    const f = await fixture();
    await assertWaiting(f, 'creating');
    await callback(f, 'heartbeat', 'different-agent-build');
    const refused = await alarm(f);
    expect(refused.state.completed).toBe(true);
    expect(await task(f)).toMatchObject({
      status: 'failed',
      error_message: 'Specified node agent build differs from the required VM agent build',
    });
    await assertNoWorkspace(f, 'creating');
  });

  it('accepts timely readiness when its alarm runs after the persisted deadline', async () => {
    const f = await fixture();
    await assertWaiting(f, 'creating');
    await callback(f, 'heartbeat');
    await callback(f, 'ready');
    // Model a delayed alarm without sleeps: the server observed readiness 90s ago,
    // 30s before its deadline; the latest heartbeat remains fresh at alarm delivery.
    const deadline = Date.now() - 60_000;
    const readyAt = new Date(deadline - 30_000).toISOString();
    await env.DATABASE.prepare('UPDATE nodes SET agent_ready_at = ? WHERE id = ?')
      .bind(readyAt, f.nodeId)
      .run();
    await runInDurableObject(f.stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('Missing runner state');
      state.agentReadyStartedAt = deadline - DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS;
      await instance.ctx.storage.put('state', state);
    });
    const selected = await alarm(f);
    expect(selected.state).toMatchObject({
      currentStep: 'workspace_creation',
      completed: false,
      stepResults: { nodeId: f.nodeId, autoProvisioned: false, workspaceId: null },
    });
    const allocated = await alarm(f);
    expect(allocated.state).toMatchObject({ currentStep: 'workspace_dispatch', completed: false });
    expect(allocated.state.stepResults.workspaceId).toEqual(expect.any(String));
    expect(await task(f)).toMatchObject({
      status: 'delegated',
      workspace_id: allocated.state.stepResults.workspaceId,
      auto_provisioned_node_id: null,
      error_message: null,
    });
    expect(
      await env.DATABASE.prepare('SELECT node_id, status FROM workspaces WHERE id = ?')
        .bind(allocated.state.stepResults.workspaceId)
        .first()
    ).toEqual({ node_id: f.nodeId, status: 'creating' });
  });

  it('refuses readiness arriving after the persisted deadline before a delayed alarm', async () => {
    const f = await fixture();
    await assertWaiting(f, 'creating');
    await runInDurableObject(f.stub, async (instance) => {
      const state = await instance.ctx.storage.get<TaskRunnerState>('state');
      if (!state) throw new Error('Missing runner state');
      state.agentReadyStartedAt = Date.now() - DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS;
      await instance.ctx.storage.put('state', state);
    });
    await callback(f, 'heartbeat');
    await callback(f, 'ready');
    const expired = await alarm(f);
    expect(expired.state.completed).toBe(true);
    expect(expired.nextAlarm).toBeNull();
    expect(await task(f)).toMatchObject({
      status: 'failed',
      error_message: 'Specified node not ready by deadline: agent readiness deadline exceeded',
    });
    await assertNoWorkspace(f, 'running');
  });

  it.each(['missing', 'deleted'])(
    'refuses a %s pinned node without provisioning a replacement',
    async (status) => {
      const f = await fixture(status === 'deleted' ? 'deleted' : 'creating');
      if (status === 'missing') {
        await env.DATABASE.prepare('DELETE FROM nodes WHERE id = ?').bind(f.nodeId).run();
      }
      const result = await alarm(f);
      expect(result.state).toMatchObject({
        completed: true,
        stepResults: { autoProvisioned: false, nodeId: null },
      });
      expect(result.nextAlarm).toBeNull();
      expect(await task(f)).toMatchObject({
        status: 'failed',
        error_message: 'Specified node is not available',
        auto_provisioned_node_id: null,
      });
    }
  );
});
