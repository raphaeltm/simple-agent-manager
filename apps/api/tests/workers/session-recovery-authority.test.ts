import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedInstallation, seedProject, seedTask, seedUser } from './helpers/seed-d1';
import type { VmAgentContainerTestDouble } from './support/vm-agent-container-double';

const USER_ID = 'guard-user';
const PROJECT_ID = 'guard-project';
const INSTALLATION_ID = 'guard-installation';

function containerStub(id: string): DurableObjectStub<VmAgentContainerTestDouble> {
  const namespace = env.VM_AGENT_CONTAINER;
  if (!namespace) throw new Error('VM_AGENT_CONTAINER test binding is unavailable');
  return namespace.get(
    namespace.idFromName(id)
  ) as unknown as DurableObjectStub<VmAgentContainerTestDouble>;
}

async function setTaskFields(
  taskId: string,
  input: {
    chatSessionId?: string | null;
    recoverySourceTaskId?: string | null;
    triggeredBy?: string | null;
    status?: string;
  }
): Promise<void> {
  await env.DATABASE.prepare(
    `UPDATE tasks
        SET chat_session_id = ?, recovery_source_task_id = ?, triggered_by = ?, status = ?
      WHERE id = ?`
  )
    .bind(
      input.chatSessionId ?? null,
      input.recoverySourceTaskId ?? null,
      input.triggeredBy ?? null,
      input.status ?? 'queued',
      taskId
    )
    .run();
}

describe('session recovery source guard — real D1/DO vertical slice', () => {
  beforeEach(async () => {
    await seedUser(USER_ID, { githubId: 'guard-gh', email: 'guard@example.test' });
    await seedInstallation(INSTALLATION_ID, USER_ID);
    await seedProject(PROJECT_ID, USER_ID, INSTALLATION_ID);
  });

  it('allows a live direct chat owner to reach the DO preparation boundary', async () => {
    const sourceTaskId = 'guard-source-direct';
    const chatSessionId = 'guard-chat-direct';
    await seedTask(sourceTaskId, PROJECT_ID, USER_ID, { status: 'awaiting_followup' });
    await setTaskFields(sourceTaskId, {
      chatSessionId,
      status: 'awaiting_followup',
    });

    await expect(
      containerStub('guard-container-direct').__guardedPrepare({
        taskId: sourceTaskId,
        projectId: PROJECT_ID,
        chatSessionId,
      })
    ).resolves.toEqual({ authorized: true, prepared: true });
  });

  it('allows a live source through its exact linked recovery owner', async () => {
    const sourceTaskId = 'guard-source-linked';
    const recoveryTaskId = 'guard-recovery-linked';
    const chatSessionId = 'guard-chat-linked';
    await seedTask(sourceTaskId, PROJECT_ID, USER_ID, { status: 'awaiting_followup' });
    await seedTask(recoveryTaskId, PROJECT_ID, USER_ID, { status: 'delegated' });
    await setTaskFields(sourceTaskId, { status: 'awaiting_followup' });
    await setTaskFields(recoveryTaskId, {
      chatSessionId,
      recoverySourceTaskId: sourceTaskId,
      triggeredBy: 'session-recovery',
      status: 'delegated',
    });

    await expect(
      containerStub('guard-container-linked').__guardedPrepare({
        taskId: sourceTaskId,
        projectId: PROJECT_ID,
        chatSessionId,
      })
    ).resolves.toEqual({ authorized: true, prepared: true });
  });

  it('rejects terminal and wrong-lineage sources before DO preparation', async () => {
    const sourceTaskId = 'guard-source-rejected';
    const unrelatedTaskId = 'guard-unrelated-owner';
    const chatSessionId = 'guard-chat-rejected';
    await seedTask(sourceTaskId, PROJECT_ID, USER_ID, { status: 'completed' });
    await seedTask(unrelatedTaskId, PROJECT_ID, USER_ID, { status: 'delegated' });
    await setTaskFields(sourceTaskId, { status: 'completed' });
    await setTaskFields(unrelatedTaskId, {
      chatSessionId,
      triggeredBy: 'session-recovery',
      status: 'delegated',
    });

    await expect(
      containerStub('guard-container-rejected').__guardedPrepare({
        taskId: sourceTaskId,
        projectId: PROJECT_ID,
        chatSessionId,
      })
    ).resolves.toEqual({ authorized: false, prepared: false });
  });
});
