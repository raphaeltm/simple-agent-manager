import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  samChatDeliveryGet,
  samChatInteractions,
  samChatInterrupt,
  samChatJobs,
  samChatStatus,
  samOperationGet,
  samWorkChanges,
} from '../../../src/operations/operational-operations';
import type { OperationContext } from '../../../src/operations/types';
import { operationReceiptId } from '../../../src/services/cli-operation-receipts';
import { recordOperationalJob } from '../../../src/services/operational-job-observations';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  state: vi.fn(),
  mailbox: vi.fn(),
  snapshot: vi.fn(),
  pending: vi.fn(),
  cancel: vi.fn(),
  ended: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  getSessionAccess: mocks.access,
  getMailboxMessage: mocks.mailbox,
  recordActivityEvent: vi.fn(async () => undefined),
  getSessionState: mocks.state,
  recordSessionTurnEnd: mocks.ended,
}));
vi.mock('../../../src/routes/chat-agent-state', () => ({ resolveChatAgentState: mocks.resolve }));
vi.mock('../../../src/services/acp-interaction-store', () => ({
  snapshotInteractions: mocks.snapshot,
  getPendingInteractionDetails: mocks.pending,
}));
vi.mock('../../../src/services/guarded-chat-interrupt', () => ({
  guardedChatInterrupt: mocks.cancel,
}));
vi.mock('../../../src/services/node-agent', () => ({ cancelAgentSessionOnNode: mocks.cancel }));

const secret = 'canary-secret-DO-NOT-EXPOSE';
const jobId = `sx-${'a'.repeat(64)}`;
describe('operational MCP evidence with real SQLite authorization and persistence', () => {
  let sqlite: Database.Database;
  let env: Env;
  const session = { projectId: 'p', sessionId: 'chat' };
  function ctx(userId = 'owner', scopes = ['sam.read', 'sam.write']): OperationContext {
    return {
      env,
      requestId: 'test',
      actor: { userId, via: 'connector', scopes: new Set(scopes as ('sam.read' | 'sam.write')[]) },
    };
  }
  beforeEach(() => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.users,
      schema.projects,
      schema.projectMembers,
      schema.tasks,
      schema.nodes,
      schema.workspaces,
      schema.agentSessions,
      schema.sessionSnapshots,
      schema.platformSettings,
    ]);
    for (const name of [
      '0189_cli_operation_receipts.sql',
      '0191_connector_execution.sql',
      '0199_operational_job_observations.sql',
    ])
      sqlite.exec(
        readFileSync(new URL(`../../../src/db/migrations/${name}`, import.meta.url), 'utf8')
      );
    sqlite.exec(`INSERT INTO projects(id,name) VALUES ('p','Project'),('foreign','Other');
      INSERT INTO users(id,name,email) VALUES ('owner','Owner','o@example.com'),('grantee','Shared','g@example.com'),('reader','Reader','r@example.com');
      INSERT INTO project_members(project_id,user_id,role,status) VALUES ('p','owner','owner','active'),('p','grantee','maintainer','active'),('p','reader','viewer','active');
      INSERT INTO tasks(id,project_id,user_id,title,status,chat_session_id) VALUES ('task','p','owner','Task','completed','chat');
      INSERT INTO nodes(id,user_id,name,status,runtime) VALUES ('node','owner','Node','running','vm');
      INSERT INTO workspaces(id,project_id,user_id,node_id,name,repository,branch,vm_size,vm_location,status,chat_session_id)
        VALUES ('workspace','p','owner','node','Workspace','repo','main','small','fsn1','running','chat');
      INSERT INTO agent_sessions(id,workspace_id,user_id,agent_type,status) VALUES ('agent','workspace','owner','claude-code','running');`);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
    mocks.access.mockImplementation(async (_env, projectId, sessionId, userId) => ({
      session:
        projectId === 'p' && sessionId === 'chat'
          ? { id: 'chat', status: 'active', createdByUserId: 'owner' }
          : null,
      access: {
        found: projectId === 'p' && sessionId === 'chat',
        ownerUserId: 'owner',
        role: userId === 'owner' ? 'owner' : userId === 'grantee' ? 'grantee' : 'none',
        grant: userId === 'grantee' ? { id: 'grant' } : null,
      },
    }));
    mocks.resolve.mockResolvedValue({
      agentSessionId: 'agent',
      agentType: 'claude-code',
      state: null,
    });
    mocks.snapshot.mockResolvedValue({ pending: [], settled: [], cursor: null });
    mocks.pending.mockResolvedValue([]);
    mocks.cancel.mockResolvedValue({ success: true, status: 200 });
    mocks.ended.mockResolvedValue({});
    mocks.state.mockResolvedValue({ promptStartedAt: 7 });
  });
  afterEach(() => sqlite.close());

  it('returns unknown activity, separates task completion from cleanup and never calls a runtime', async () => {
    sqlite.prepare('UPDATE tasks SET error_message=?').run(secret);
    sqlite
      .prepare('UPDATE workspaces SET error_message=?,resolved_reservation_json=?')
      .run(secret, JSON.stringify({ cpuMillis: 1000, memoryMb: 512, diskMb: 2048, secret }));
    const result = await samChatStatus.run(ctx(), session);
    expect(result.task?.status).toBe('completed');
    expect(result.runtime.idleness.conclusive).toBe(false);
    expect(result.resources.cleanup.state).toBe('unknown');
    expect(result.resources.reservation).toEqual({ cpuMillis: 1000, memoryMb: 512, diskMb: 2048 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status: 'running' });
  });
  it('keeps a recently completed task with an active prompt non-idle', async () => {
    const now = Date.now();
    sqlite.prepare('UPDATE tasks SET completed_at=?').run(new Date(now).toISOString());
    mocks.resolve.mockResolvedValue({
      agentSessionId: 'agent',
      agentType: 'claude-code',
      state: {
        activity: 'prompting',
        activityAt: now,
        promptStartedAt: now,
        runtimeWorkState: null,
      },
    });
    const result = await samChatStatus.run(ctx(), session);
    expect(result.runtime.idleness.idle).toBe(false);
    expect(result.runtime.idleness.reason).toBe('prompt_turn_active');
  });
  it('exposes runtime deletion proof separately from node release and metadata cleanup', async () => {
    sqlite.exec("UPDATE workspaces SET runtime_deletion_confirmed_at='2026-10-20T00:00:00Z'");
    const result = await samChatStatus.run(ctx(), session);
    expect(result.resources.cleanup.state).toBe('runtime_deletion_confirmed');
    expect(result.resources.nodeRelease).toBe('unknown');
    expect(result.resources.cleanup.filesystemAndMetadataCleanup).toBe('unknown');
  });
  it('checks current writer grant, membership, project and read scope before evidence lookup', async () => {
    for (const op of [samChatStatus, samWorkChanges, samChatInteractions, samChatJobs]) {
      await expect(op.run(ctx('reader'), session)).rejects.toThrow();
      await expect(op.run(ctx('owner', []), session)).rejects.toThrow();
      await expect(op.run(ctx(), { ...session, projectId: 'foreign' })).rejects.toThrow();
    }
    await expect(samChatStatus.run(ctx('grantee'), session)).resolves.toMatchObject({
      workspaceId: 'workspace',
    });
    sqlite.exec("UPDATE project_members SET status='removed' WHERE user_id='grantee'");
    await expect(samChatStatus.run(ctx('grantee'), session)).rejects.toThrow();
  });
  it('checks delivery session ownership and excludes raw content, metadata and errors', async () => {
    mocks.mailbox.mockResolvedValue({
      id: 'delivery',
      targetSessionId: 'chat',
      promptMessageId: 'message',
      content: secret,
      metadata: { secret },
      lastError: secret,
      terminalReason: secret,
      deliveryState: 'retry_wait',
      deliveryAttempts: 2,
      nextAttemptAt: 123,
      receiptSupported: true,
      receiptState: 'accepted',
    });
    const result = await samChatDeliveryGet.run(ctx(), { ...session, deliveryId: 'delivery' });
    expect(result).toMatchObject({
      state: 'retry_wait',
      attempts: 2,
      nextAttemptAt: 123,
      consumption: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    mocks.mailbox.mockResolvedValue({ targetSessionId: 'other' });
    await expect(
      samChatDeliveryGet.run(ctx(), { ...session, deliveryId: 'foreign' })
    ).rejects.toThrow('not found');
  });
  it('shares pending permission options/forms with a current writer and exposes settled delivery outcome', async () => {
    mocks.pending.mockResolvedValue([
      { interactionId: 'question', kind: 'form', detail: { schema: { type: 'object' } } },
    ]);
    mocks.snapshot.mockResolvedValue({
      pending: [],
      settled: [
        {
          interactionId: 'answer',
          state: 'delivery_unconfirmed',
          deliveryState: 'unconfirmed',
          answeredAt: 4,
          rawError: secret,
        },
      ],
      cursor: '100',
    });
    const result = await samChatInteractions.run(ctx('grantee'), session);
    expect(result.pending[0]).toMatchObject({ formSchema: { type: 'object' }, canDecline: true });
    expect(result.settled[0]).toMatchObject({ state: 'delivery_unconfirmed', answeredAt: 4 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('changes cursor tracks retained state and rejects actor/session cursor reuse', async () => {
    const initial = await samWorkChanges.run(ctx(), session);
    const same = await samWorkChanges.run(ctx(), { ...session, cursor: initial.cursor });
    expect(same).toMatchObject({ changed: false, snapshot: null });
    sqlite.exec("UPDATE tasks SET status='failed'");
    const changed = await samWorkChanges.run(ctx(), { ...session, cursor: initial.cursor });
    expect(changed.changed).toBe(true);
    expect(changed.snapshot?.task?.status).toBe('failed');
    await expect(
      samWorkChanges.run(ctx('grantee'), { ...session, cursor: initial.cursor })
    ).rejects.toThrow('Cursor');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('records typed job metadata monotonically and never exposes output or polls the runtime', async () => {
    const scope = {
      projectId: 'p',
      chatSessionId: 'chat',
      userId: 'owner',
      workspaceId: 'workspace',
      agentSessionId: 'agent',
    };
    await recordOperationalJob(env, scope, { jobId, status: 'running', exitCode: 0 });
    await recordOperationalJob(env, scope, { jobId, status: 'failed', exitCode: 7 });
    await recordOperationalJob(env, scope, { jobId, status: 'running', exitCode: 0 });
    const result = await samChatJobs.run(ctx('grantee'), session);
    expect(result.jobs).toEqual([
      expect.objectContaining({ jobId, source: 'secret_exec', status: 'failed', exitCode: 7 }),
    ]);
    expect(result.harnessHistory).toBe('unsupported');
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it('looks up only the actor receipt and projects IDs rather than saved content', async () => {
    const receiptId = await operationReceiptId('p', 'owner', 'CONNECTOR', 'sam_chat_send', 'key');
    sqlite
      .prepare(
        "INSERT INTO cli_operation_receipts(receipt_id,project_id,user_id,intent_hash,state,response_json) VALUES (?,'p','owner','hash','completed',?)"
      )
      .run(
        receiptId,
        JSON.stringify({
          status: 'queued',
          deliveryId: 'delivery',
          content: secret,
          arbitrary: secret,
        })
      );
    const input = { projectId: 'p', operation: 'sam_chat_send', requestKey: 'key' };
    expect(await samOperationGet.run(ctx(), input)).toMatchObject({
      state: 'completed',
      result: { deliveryId: 'delivery', status: 'queued' },
    });
    expect(JSON.stringify(await samOperationGet.run(ctx(), input))).not.toContain(secret);
    expect(await samOperationGet.run(ctx('grantee'), input)).toMatchObject({ state: 'unknown' });
    sqlite.prepare("UPDATE cli_operation_receipts SET state='pending', response_json=NULL").run();
    expect(await samOperationGet.run(ctx(), input)).toMatchObject({ state: 'pending_uncertain' });
  });
  it('interrupts once for a request key, preserves workspace/task and fences stale runtime/turn observations', async () => {
    const input = {
      ...session,
      requestKey: 'interrupt',
      expectedAgentSessionId: 'agent',
      expectedPromptStartedAt: 7,
    };
    await expect(samChatInterrupt.run(ctx('grantee'), input)).resolves.toMatchObject({
      status: 'cancelled',
    });
    await samChatInterrupt.run(ctx('grantee'), input);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.cancel).toHaveBeenCalledWith(
      env,
      'node',
      'workspace',
      'agent',
      'owner',
      7,
      expect.any(Function)
    );
    expect(sqlite.prepare('SELECT status FROM tasks').get()).toEqual({ status: 'completed' });
    expect(sqlite.prepare('SELECT status FROM workspaces').get()).toEqual({ status: 'running' });
    await expect(
      samChatInterrupt.run(ctx(), {
        ...session,
        requestKey: 'stale',
        expectedPromptStartedAt: 7,
        expectedAgentSessionId: 'old',
      })
    ).rejects.toThrow('Runtime changed');
    mocks.state.mockResolvedValue({ promptStartedAt: 9 });
    await expect(
      samChatInterrupt.run(ctx(), {
        ...session,
        requestKey: 'turn',
        expectedAgentSessionId: 'agent',
        expectedPromptStartedAt: 8,
      })
    ).rejects.toThrow('Prompt turn changed');
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.ended).toHaveBeenCalledWith(
      env,
      'p',
      'agent',
      expect.objectContaining({ reason: 'cancelled', observedAt: expect.any(Number) })
    );
  });
});
