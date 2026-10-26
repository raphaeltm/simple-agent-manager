import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { PromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery';
import {
  invalidProjectEventWakeSourceTaskResult,
  sourceTaskGuardForClaim,
} from '../../../src/durable-objects/project-data/prompt-delivery-source-guards';
import type { Env } from '../../../src/env';
import {
  isSessionRecoverySourceTaskGuardValid,
  isSessionRecoveryTaskAuthorized,
} from '../../../src/services/session-recovery-authority';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

it('carries trigger principal membership through immediate wake and asynchronous recovery', async () => {
  const sqlite = new Database(':memory:');
  try {
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`INSERT INTO users(id,status) VALUES('principal','active');
      INSERT INTO project_members(project_id,user_id,status,role) VALUES('p','principal','active','maintainer');
      INSERT INTO tasks(id,project_id,user_id,status,chat_session_id) VALUES('source','p','principal','sleeping','chat');
      INSERT INTO tasks(id,project_id,user_id,status,chat_session_id,recovery_source_task_id,triggered_by) VALUES('recovery','p','principal','queued','chat','source','session-recovery');
      INSERT INTO session_snapshots(project_id,chat_session_id,recovery_task_id,recovery_status) VALUES('p','chat','recovery','waking');`);
    const env = { DATABASE: createSqliteD1(sqlite) } as Env;
    const claim = {
      mode: 'submit',
      attemptId: 'attempt',
      message: {
        id: 'event',
        targetSessionId: 'chat',
        sourceTaskId: 'source',
        sourceKind: 'github_trigger',
        runtimeIdentity: null,
        metadata: { creatorUserId: 'principal' },
      },
    } as PromptDeliveryClaim;
    expect(await invalidProjectEventWakeSourceTaskResult(env, 'p', claim)).toBeNull();
    const guard = sourceTaskGuardForClaim(claim, 'p');
    expect(guard).toEqual({
      taskId: 'source',
      projectId: 'p',
      chatSessionId: 'chat',
      requireSourceProjectMember: true,
      requiredProjectMemberId: 'principal',
    });
    if (!guard) throw new Error('Missing recovery authority');
    const asyncGuard = {
      recoveryTaskId: 'recovery',
      sourceTaskId: 'source',
      projectId: 'p',
      chatSessionId: 'chat',
      requiredProjectMemberId: guard.requiredProjectMemberId,
    };
    expect(await isSessionRecoveryTaskAuthorized(env.DATABASE, asyncGuard)).toBe(true);
    // Revocation lands after DO admission but before physical wake or a TaskRunner alarm.
    sqlite
      .prepare(
        "UPDATE project_members SET status='removed' WHERE project_id='p' AND user_id='principal'"
      )
      .run();
    expect(await isSessionRecoverySourceTaskGuardValid(env.DATABASE, guard)).toBe(false);
    expect(await isSessionRecoveryTaskAuthorized(env.DATABASE, asyncGuard)).toBe(false);
    expect(await invalidProjectEventWakeSourceTaskResult(env, 'p', claim)).toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
    });
  } finally {
    sqlite.close();
  }
});

describe('GitHub trigger wake provenance', () => {
  it('fails closed when the internal durable handoff has no principal', async () => {
    const claim = {
      mode: 'submit',
      attemptId: 'attempt',
      message: {
        id: 'event',
        targetSessionId: 'chat',
        sourceTaskId: 'source',
        sourceKind: 'github_trigger',
        runtimeIdentity: null,
        metadata: {},
      },
    } as PromptDeliveryClaim;
    expect(await invalidProjectEventWakeSourceTaskResult({} as Env, 'p', claim)).toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
    });
  });
});
