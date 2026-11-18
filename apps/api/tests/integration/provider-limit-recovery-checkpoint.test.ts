import '../helpers/provider-limit-owner-resume-harness';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadProviderLimitRecoveryApproval,
  providerLimitRecoveryApprovalIsCurrent,
} from '../../src/services/provider-limit-recovery-approval';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

describe('owner recovery source identity across checkpoint publication', () => {
  let harness: Awaited<ReturnType<typeof createOwnerResumeHarness>>;
  let approval: NonNullable<Awaited<ReturnType<typeof loadProviderLimitRecoveryApproval>>>;

  beforeEach(async () => {
    vi.resetAllMocks();
    boundary.userId = 'user-1';
    boundary.nudge.mockResolvedValue(true);
    boundary.selected.mockResolvedValue('cc_credentials:account-1');
    harness = await createOwnerResumeHarness();
    expect((await harness.resume()).status).toBe(202);
    approval = (await loadProviderLimitRecoveryApproval(
      harness.env,
      'task-1',
      harness.task().provider_limit_wait_json as string
    ))!;
    harness.d1.exec(`
      INSERT INTO workspaces(id,user_id,project_id,node_id,status,branch,vm_size,vm_location,workspace_profile,created_at,updated_at)
      VALUES ('replacement','user-1','project-1','node-1','running','main','small','nbg1','lightweight',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
      UPDATE tasks SET status='delegated',workspace_id='replacement' WHERE id='task-1';
      UPDATE session_snapshots SET workspace_id='replacement',sleeping_at=NULL,
        recovery_status=NULL,sleep_status='awake' WHERE id='snapshot-1';
    `);
  });
  afterEach(() => harness.close());

  const current = () =>
    providerLimitRecoveryApprovalIsCurrent(harness.env, 'task-1', 'project-1', approval, true);

  it('retains the approved original source when a new checkpoint changes the live workspace', async () => {
    expect(await current()).toBe(true);
    expect(
      harness.d1.prepare("SELECT workspace_id FROM agent_sessions WHERE id='source-1'").get()
    ).toEqual({ workspace_id: 'workspace-1' });
  });

  it.each([
    "UPDATE workspaces SET project_id=NULL WHERE id='workspace-1'",
    "UPDATE workspaces SET user_id='other-owner' WHERE id='workspace-1'",
    "UPDATE agent_sessions SET agent_credential_generation=8 WHERE id='source-1'",
    "UPDATE agent_sessions SET agent_credential_reference='cc_credentials:other' WHERE id='source-1'",
  ])('refuses a changed original source: %s', async (change) => {
    harness.d1.pragma('foreign_keys = OFF');
    harness.d1.exec(change);
    expect(await current()).toBe(false);
  });
});
