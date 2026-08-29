/**
 * Source contract tests for the TaskRunner DO service layer.
 *
 * Validates that task-runner-do.ts correctly bridges routes to the DO,
 * and that the routes are properly wired to use the DO instead of waitUntil.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { startTaskRunnerDO } from '../../src/services/task-runner-do';

const serviceSource = readFileSync(
  resolve(process.cwd(), 'src/services/task-runner-do.ts'),
  'utf8'
);
const taskSubmitSource = readFileSync(resolve(process.cwd(), 'src/routes/tasks/submit.ts'), 'utf8');
const taskRunsSource = readFileSync(resolve(process.cwd(), 'src/routes/tasks/run.ts'), 'utf8');
const workspacesSource = [
  readFileSync(resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'), 'utf8'),
  readFileSync(resolve(process.cwd(), 'src/routes/workspaces/runtime.ts'), 'utf8'),
].join('\n');
const stuckTasksSource = readFileSync(
  resolve(process.cwd(), 'src/scheduled/stuck-tasks.ts'),
  'utf8'
);

function createTaskRunnerEnv(start = vi.fn().mockResolvedValue(undefined)) {
  return {
    env: {
      TASK_RUNNER: {
        idFromName: vi.fn((taskId: string) => `task-runner:${taskId}`),
        get: vi.fn(() => ({ start })),
      },
    } as unknown as Env,
    start,
  };
}

function capacityPoolSelection(overrides: {
  provider: 'hetzner' | 'scaleway';
  location: 'nbg1' | 'fsn1' | 'fr-par-1';
  candidateCount?: number;
}) {
  const snapshot = {
    capacityPoolId: 'pool-task-runner-unit',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 1,
    capacitySourceId: 'source-task-runner-unit',
    capacityPoolCandidateId: 'candidate-task-runner-unit',
    placementCredentialSource: 'user' as const,
    placementCredentialReference: 'credentials:user-cloud-unit',
    placementCredentialVersion: 1,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    placementExplanationJson: JSON.stringify({
      poolId: 'pool-task-runner-unit',
      capacitySourceId: 'source-task-runner-unit',
      capacityPoolCandidateId: 'candidate-task-runner-unit',
    }),
  };

  const candidateCount = overrides.candidateCount ?? 1;
  const candidates = Array.from({ length: candidateCount }, (_, index) => {
    const id =
      index === 0
        ? snapshot.capacityPoolCandidateId
        : `candidate-task-runner-unit-${String(index).padStart(3, '0')}`;
    const providerInstanceType =
      overrides.provider === 'hetzner'
        ? index === 0
          ? 'cx23'
          : `cx${23 + index}`
        : index === 0
          ? 'DEV1-M'
          : `DEV1-${index}`;
    const candidateSnapshot = {
      ...snapshot,
      capacityPoolCandidateId: id,
      providerInstanceType,
      providerInstanceVcpuCount: 2 + (index % 8),
      providerInstanceMemoryMb: 4096 + index * 1024,
      providerInstanceDiskGb: 40 + index,
      providerInstancePriceDisplay: `€${(5 + index).toFixed(2)}/mo`,
      providerInstancePriceCurrency: 'EUR',
      providerInstancePriceMonthlyCents: 500 + index,
      providerInstancePriceHourlyMicros: 8_000 + index,
      placementExplanationJson: JSON.stringify({
        poolId: 'pool-task-runner-unit',
        capacitySourceId: 'source-task-runner-unit',
        capacityPoolCandidateId: id,
        providerInstanceType,
        repeatedLiveCatalogMetadata: 'x'.repeat(1800),
      }),
    };

    return {
      id,
      poolId: snapshot.capacityPoolId,
      capacitySourceId: snapshot.capacitySourceId,
      provider: overrides.provider,
      location: overrides.location,
      workloadRole: 'workspace' as const,
      runtime: 'vm',
      machineClass: 'shared-vm',
      machineSize: 'medium' as const,
      providerInstanceType,
      providerInstanceVcpuCount: candidateSnapshot.providerInstanceVcpuCount,
      providerInstanceMemoryMb: candidateSnapshot.providerInstanceMemoryMb,
      providerInstanceDiskGb: candidateSnapshot.providerInstanceDiskGb,
      providerInstancePriceDisplay: candidateSnapshot.providerInstancePriceDisplay,
      providerInstancePriceCurrency: candidateSnapshot.providerInstancePriceCurrency,
      providerInstancePriceMonthlyCents: candidateSnapshot.providerInstancePriceMonthlyCents,
      providerInstancePriceHourlyMicros: candidateSnapshot.providerInstancePriceHourlyMicros,
      priority: index,
      candidateOrder: index,
      credentialAttributionSource: 'user' as const,
      placementCredentialSource: 'user' as const,
      placementCredentialReference: snapshot.placementCredentialReference,
      placementCredentialVersion: snapshot.placementCredentialVersion,
      capacityPoolProjectId: null,
      snapshot: candidateSnapshot,
    };
  });

  return {
    poolId: snapshot.capacityPoolId,
    scope: 'user' as const,
    revision: 1,
    strategy: 'balanced' as const,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
    candidates,
  };
}

const minimalStartInput = {
  taskId: 'task-runner-unit',
  projectId: 'project-runner-unit',
  userId: 'user-runner-unit',
  vmSize: 'medium' as const,
  vmLocation: 'nbg1' as const,
  branch: 'main',
  taskTitle: 'TaskRunner unit contract',
  repository: 'test-org/test-repo',
  installationId: 'installation-runner-unit',
};

describe('task-runner-do service', () => {
  it('exports startTaskRunnerDO function', () => {
    expect(serviceSource).toContain('export async function startTaskRunnerDO(');
  });

  it('exports advanceTaskRunnerWorkspaceReady function', () => {
    expect(serviceSource).toContain('export async function advanceTaskRunnerWorkspaceReady(');
  });

  it('exports getTaskRunnerStatus function', () => {
    expect(serviceSource).toContain('export async function getTaskRunnerStatus(');
  });

  it('exports ensureTaskRunnerStarted function', () => {
    expect(serviceSource).toContain('export async function ensureTaskRunnerStarted(');
    expect(serviceSource).toContain('return stub.ensureStarted()');
  });

  it('uses typed DO stub via getStub helper', () => {
    expect(serviceSource).toContain(
      'function getStub(env: Env, taskId: string): DurableObjectStub<TaskRunner>'
    );
  });

  it('uses idFromName(taskId) for deterministic mapping', () => {
    expect(serviceSource).toContain('env.TASK_RUNNER.idFromName(taskId)');
  });

  it('casts stub to typed DurableObjectStub<TaskRunner>', () => {
    expect(serviceSource).toContain('as DurableObjectStub<TaskRunner>');
  });

  it('calls stub.start() with StartTaskInput', () => {
    expect(serviceSource).toContain('await stub.start(startInput)');
  });

  it('calls stub.advanceWorkspaceReady()', () => {
    expect(serviceSource).toContain('await stub.advanceWorkspaceReady(status, errorMessage)');
  });

  it('calls stub.getStatus()', () => {
    expect(serviceSource).toContain('return stub.getStatus()');
  });

  it('passes all config fields to StartTaskInput', () => {
    const configFields = [
      'vmSize',
      'vmLocation',
      'branch',
      'preferredNodeId',
      'userName',
      'userEmail',
      'githubId',
      'taskTitle',
      'taskDescription',
      'repository',
      'installationId',
      'outputBranch',
      'projectDefaultVmSize',
      'agentType',
      'model',
      'permissionMode',
    ];
    for (const field of configFields) {
      expect(serviceSource).toContain(field);
    }
  });

  it('does not forward a capacity candidate that conflicts with explicit placement', async () => {
    const { env, start } = createTaskRunnerEnv();

    await startTaskRunnerDO(env, {
      ...minimalStartInput,
      cloudProvider: 'hetzner',
      explicitVmLocation: true,
      capacityPoolSelection: capacityPoolSelection({
        provider: 'scaleway',
        location: 'fr-par-1',
      }),
    });

    const forwarded = start.mock.calls[0]?.[0];
    expect(forwarded.config.cloudProvider).toBe('hetzner');
    expect(forwarded.config.vmLocation).toBe('nbg1');
    expect(forwarded.config.capacityPoolSelection).toBeNull();
  });

  it('forwards matching capacity candidates so flexible location choice is preserved', async () => {
    const { env, start } = createTaskRunnerEnv();

    await startTaskRunnerDO(env, {
      ...minimalStartInput,
      cloudProvider: 'hetzner',
      explicitVmLocation: false,
      capacityPoolSelection: capacityPoolSelection({
        provider: 'hetzner',
        location: 'fsn1',
      }),
    });

    const forwarded = start.mock.calls[0]?.[0];
    expect(forwarded.config.cloudProvider).toBe('hetzner');
    expect(forwarded.config.vmLocation).toBe('fsn1');
    expect(forwarded.config.capacityPoolSelection?.candidates[0]).toMatchObject({
      provider: 'hetzner',
      location: 'fsn1',
    });
  });

  it('strips duplicated candidate snapshots while retaining compact catalog breadth', async () => {
    const { env, start } = createTaskRunnerEnv();

    await startTaskRunnerDO(env, {
      ...minimalStartInput,
      cloudProvider: 'hetzner',
      explicitVmLocation: false,
      capacityPoolSelection: capacityPoolSelection({
        provider: 'hetzner',
        location: 'fsn1',
        candidateCount: 4,
      }),
    });

    const forwarded = start.mock.calls[0]?.[0];
    const candidates = forwarded.config.capacityPoolSelection?.candidates ?? [];
    expect(candidates).toHaveLength(4);
    expect(candidates.every((candidate: object) => !('snapshot' in candidate))).toBe(true);
    expect(candidates[0]).toMatchObject({
      providerInstanceType: 'cx23',
      providerInstancePriceCurrency: 'EUR',
    });
    expect(candidates[1]).toMatchObject({
      providerInstanceType: 'cx24',
      providerInstancePriceCurrency: null,
      providerInstancePriceMonthlyCents: null,
      providerInstancePriceHourlyMicros: null,
    });
  });

  it('keeps large provider-native catalogs below the Durable Object value-size limit', async () => {
    const { env, start } = createTaskRunnerEnv();

    await startTaskRunnerDO(env, {
      ...minimalStartInput,
      taskDescription: 'x'.repeat(16_000),
      cloudProvider: 'hetzner',
      explicitVmLocation: false,
      capacityPoolSelection: capacityPoolSelection({
        provider: 'hetzner',
        location: 'fsn1',
        candidateCount: 160,
      }),
    });

    const forwarded = start.mock.calls[0]?.[0];
    const serializedBytes = new TextEncoder().encode(JSON.stringify(forwarded.config)).length;

    expect(serializedBytes).toBeLessThan(131_072);
    expect(forwarded.config.capacityPoolSelection?.candidates[0]).toMatchObject({
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'cx23',
      providerInstancePriceDisplay: '€5.00/mo',
      providerInstancePriceCurrency: 'EUR',
    });
  });
});

describe('task-submit route uses TaskRunner DO', () => {
  it('imports startTaskRunnerDO (not executeTaskRun)', () => {
    expect(taskSubmitSource).toContain(
      "import { startTaskRunnerDO } from '../../services/task-runner-do'"
    );
    expect(taskSubmitSource).not.toContain('executeTaskRun');
    expect(taskSubmitSource).not.toContain('initiateTaskRun');
  });

  it('calls startTaskRunnerDO instead of waitUntil(executeTaskRun(...))', () => {
    expect(taskSubmitSource).toContain('await startTaskRunnerDO(c.env,');
    expect(taskSubmitSource).not.toContain('waitUntil(\n    executeTaskRun');
  });

  it('passes project repository and installationId', () => {
    expect(taskSubmitSource).toContain('repository: project.repository');
    expect(taskSubmitSource).toContain('installationId: project.installationId');
  });

  it('passes user identity fields', () => {
    expect(taskSubmitSource).toContain('userName: auth.user.name');
    expect(taskSubmitSource).toContain('userEmail: auth.user.email');
    expect(taskSubmitSource).toContain('githubId: userRow?.githubId');
  });

  it('passes agentType from request body', () => {
    expect(taskSubmitSource).toContain('agentType: body.agentType');
  });
});

describe('task-runs route uses TaskRunner DO', () => {
  it('imports startTaskRunnerDO (not initiateTaskRun)', () => {
    expect(taskRunsSource).toContain(
      "import { startTaskRunnerDO } from '../../services/task-runner-do'"
    );
    expect(taskRunsSource).not.toContain('initiateTaskRun');
  });

  it('still imports cleanupTaskRun for cleanup endpoint', () => {
    expect(taskRunsSource).toContain("import { cleanupTaskRun } from '../../services/task-runner'");
  });

  it('transitions task to queued before starting DO', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    // Raw D1 query uses status = 'queued' (with optimistic lock on status = 'ready')
    const queuedIdx = runSection.indexOf("status = 'queued'");
    const doIdx = runSection.indexOf('startTaskRunnerDO');
    expect(queuedIdx).toBeGreaterThan(-1);
    expect(doIdx).toBeGreaterThan(queuedIdx);
  });

  it('records status event before starting DO', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    expect(runSection).toContain('taskStatusEvents');
    expect(runSection).toContain("'ready'");
    expect(runSection).toContain("toStatus: 'queued'");
  });

  it('returns 202 with queued status', () => {
    expect(taskRunsSource).toContain("status: 'queued'");
    expect(taskRunsSource).toContain('c.json(response, 202)');
  });
});

describe('workspace ready callback notifies TaskRunner DO', () => {
  it('workspace ready route imports advanceTaskRunnerWorkspaceReady', () => {
    expect(workspacesSource).toContain('advanceTaskRunnerWorkspaceReady');
  });

  it('looks up associated task by workspaceId', () => {
    // The callback finds the task linked to this workspace
    expect(workspacesSource).toContain('eq(schema.tasks.workspaceId, workspaceId)');
  });

  it('only notifies for tasks in queued or delegated status', () => {
    expect(workspacesSource).toContain("inArray(schema.tasks.status, ['queued', 'delegated'])");
  });

  it('notifies DO inline (not waitUntil) per TDF-5', () => {
    const readySection = workspacesSource.slice(
      workspacesSource.indexOf("/:id/ready'"),
      workspacesSource.indexOf("/:id/provisioning-failed'")
    );
    // TDF-5: moved from waitUntil to inline await
    expect(readySection).not.toContain('c.executionCtx.waitUntil(');
    expect(readySection).toContain('advanceTaskRunnerWorkspaceReady');
    expect(readySection).toContain('await advanceTaskRunnerWorkspaceReady');
  });

  it('provisioning-failed route also notifies DO', () => {
    const failedSection = workspacesSource.slice(
      workspacesSource.indexOf("/:id/provisioning-failed'"),
      workspacesSource.indexOf("/:id/agent-key'")
    );
    expect(failedSection).toContain('advanceTaskRunnerWorkspaceReady');
    expect(failedSection).toContain("'error'");
  });
});

describe('stuck-tasks cron compatibility with TaskRunner DO', () => {
  it('documents TDF-2 compatibility in header comment', () => {
    expect(stuckTasksSource).toContain('TDF-2 compatibility');
  });

  it('mentions optimistic locking as safety mechanism', () => {
    expect(stuckTasksSource).toContain('optimistic locking');
  });

  it('still queries queued/delegated/in_progress tasks', () => {
    expect(stuckTasksSource).toContain("status IN ('queued', 'delegated', 'in_progress')");
  });

  it('still calls cleanupTaskRun on stuck tasks', () => {
    expect(stuckTasksSource).toContain('cleanupTaskRun(task.id, env)');
  });
});

describe('no waitUntil(executeTaskRun) remaining in routes', () => {
  it('task-submit does not use waitUntil for orchestration', () => {
    // waitUntil should only be used for best-effort operations (activity events)
    const submitSection = taskSubmitSource.slice(taskSubmitSource.indexOf('startTaskRunnerDO'));
    expect(submitSection).not.toContain('waitUntil(\n    executeTaskRun');
  });

  it('task-runs does not use waitUntil for orchestration', () => {
    const runSection = taskRunsSource.slice(
      taskRunsSource.indexOf("'/:taskId/run'"),
      taskRunsSource.indexOf("'/:taskId/run/cleanup'")
    );
    expect(runSection).not.toContain('waitUntil(\n    executeTaskRun');
    expect(runSection).not.toContain('initiateTaskRun');
  });
});
