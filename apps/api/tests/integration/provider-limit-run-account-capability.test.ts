/** Real SQL/crypto/selector -> owner Resume -> authenticated final credential release. */
import '../helpers/provider-limit-owner-resume-harness';

import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';

import { AppError } from '../../src/middleware/error';
import { runtimeRoutes } from '../../src/routes/workspaces/runtime';
import { encrypt } from '../../src/services/encryption';
import { boundary, createOwnerResumeHarness } from '../helpers/provider-limit-owner-resume-harness';

vi.mock('../../src/services/jwt', () => ({
  verifyCallbackToken: vi.fn(async () => ({
    workspace: 'restored-workspace',
    type: 'callback',
    scope: 'workspace',
    callbackGeneration: null,
  })),
  signCallbackToken: vi.fn(),
  signCurrentWorkspaceCallbackToken: vi.fn(),
}));

it.each([false, true])(
  'resumes and injects real run account B over default A (past repair window=%s)',
  async (pastRepairWindow) => {
    const encryptionKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const h = await createOwnerResumeHarness({ ENCRYPTION_KEY: encryptionKey });
    try {
      const actual = await vi.importActual<
        typeof import('../../src/services/agent-credential-selection')
      >('../../src/services/agent-credential-selection');
      boundary.selected.mockImplementation(actual.getSelectedAgentCredentialReference as never);
      boundary.nudge.mockResolvedValue(true);
      for (const account of ['default-a', 'account-1']) {
        const secret = await encrypt(`${account}-secret`, encryptionKey);
        h.d1
          .prepare(
            `INSERT INTO cc_credentials(id,owner_id,name,kind,encrypted_token,iv,is_active) VALUES(?,'user-1',?,'api-key',?,?,1)`
          )
          .run(account, account, secret.ciphertext, secret.iv);
        h.d1
          .prepare(
            `INSERT INTO cc_configurations(id,owner_id,name,consumer_kind,consumer_target,credential_id,is_active) VALUES(?,'user-1',?,'agent','claude-code',?,1)`
          )
          .run(`config-${account}`, account, account);
      }
      h.d1
        .exec(`INSERT INTO cc_attachments(id,configuration_id,consumer_kind,consumer_target,user_id,is_active)
      VALUES('default','config-default-a','agent','claude-code','user-1',1);
      UPDATE tasks SET agent_configuration_id='config-account-1';`);
      const resumed = await h.resume();
      expect(resumed.status, await resumed.clone().text()).toBe(202);
      if (pastRepairWindow) {
        const repairDeadline = h.wait().ownerOverride!.repairExpiresAt!;
        expect(repairDeadline).toBeLessThan(h.wait().deadlineAt);
        vi.spyOn(Date, 'now').mockReturnValue(repairDeadline + 1);
      }
      h.d1.exec(`INSERT INTO workspaces(id,user_id,project_id,node_id,status,chat_session_id)
      VALUES('restored-workspace','user-1','project-1','node-1','running','chat-1');
      INSERT INTO agent_sessions(id,user_id,workspace_id,status,agent_type,agent_profile_id,agent_credential_generation)
      VALUES('restored-agent','user-1','restored-workspace','running','claude-code','profile-1',0);
      UPDATE tasks SET workspace_id='restored-workspace',status='delegated';`);
      const app = new Hono<{ Bindings: typeof h.env }>();
      app.onError((err, c) =>
        err instanceof AppError
          ? c.json(err.toJSON(), err.statusCode)
          : c.json({ error: String(err) }, 500)
      );
      app.route('/api/workspaces', runtimeRoutes);
      const injected = await app.request(
        '/api/workspaces/restored-workspace/agent-key',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer callback', 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentType: 'claude-code', agentSessionId: 'restored-agent' }),
        },
        h.env
      );
      expect(injected.status, await injected.clone().text()).toBe(200);
      expect(await injected.json()).toMatchObject({
        apiKey: 'account-1-secret',
        credentialReference: 'cc_credentials:account-1',
      });
      expect(
        h.d1
          .prepare(
            "SELECT agent_credential_reference AS reference FROM agent_sessions WHERE id='restored-agent'"
          )
          .get()
      ).toEqual({ reference: 'cc_credentials:account-1' });
      expect(h.wait().ownerOverride?.firstInjection?.agentSessionId).toBe('restored-agent');
    } finally {
      h.close();
    }
  }
);
