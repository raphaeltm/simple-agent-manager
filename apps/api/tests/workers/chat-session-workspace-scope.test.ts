/**
 * Behavioral tests for resolveLiveWorkspaceForSession (chat.ts) against real D1.
 *
 * These tests validate the actual query-layer WHERE-clause scoping that the
 * unit tests (chat-prompt.test.ts / chat-cancel-prompt.test.ts) cannot — those
 * mock drizzle and ignore the WHERE clause, so they only exercise the
 * post-query defence-in-depth assertion. Here we seed real cross-tenant rows
 * and confirm the helper's SQL filters them out, proving the IDOR fix at the
 * source (see SAM idea 01KTFA3S3YX6SJ7VF1BCH0PCYM, .claude/rules/11, 28).
 */
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import { resolveLiveWorkspaceForSession } from '../../src/routes/chat-workspace-resolver';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const PREFIX = `chatscope-${Date.now()}`;
const USER_A = `${PREFIX}-userA`;
const USER_B = `${PREFIX}-userB`;
const INSTALL_A = `${PREFIX}-instA`;
const INSTALL_B = `${PREFIX}-instB`;
const PROJECT_A = `${PREFIX}-projA`;
const PROJECT_B = `${PREFIX}-projB`;
const NODE_A = `${PREFIX}-nodeA`;
const NODE_B = `${PREFIX}-nodeB`;
// The chat session id that the victim workspace (WS_A) is keyed on. An attacker
// who learns/guesses this id must NOT be able to resolve the victim's workspace
// from another tenant's scope.
const SHARED_SESSION = `${PREFIX}-session`;
// Distinct session id for the attacker's own workspace (WS_B). The workspaces
// table has a partial UNIQUE index on chat_session_id (idx_workspaces_chat_session_id_unique
// WHERE chat_session_id IS NOT NULL), so two workspaces can never share a chat
// session id — that 1:1 mapping is itself a security property. WS_B exists as a
// decoy to prove the resolver returns the *correct* workspace for SHARED_SESSION
// and never leaks across tenants.
const SESSION_B = `${PREFIX}-sessionB`;
const WS_A = `${PREFIX}-wsA`;
const WS_B = `${PREFIX}-wsB`;

describe('resolveLiveWorkspaceForSession — query-layer tenant scoping', () => {
  beforeAll(async () => {
    await seedUser(USER_A, { githubId: `gh-${USER_A}` });
    await seedUser(USER_B, { githubId: `gh-${USER_B}` });
    await seedInstallation(INSTALL_A, USER_A, { installationIdValue: `inst-${USER_A}`, accountName: USER_A });
    await seedInstallation(INSTALL_B, USER_B, { installationIdValue: `inst-${USER_B}`, accountName: USER_B });
    await seedProject(PROJECT_A, USER_A, INSTALL_A, { name: `proj ${PROJECT_A}` });
    await seedProject(PROJECT_B, USER_B, INSTALL_B, { name: `proj ${PROJECT_B}` });
    await seedNode(NODE_A, USER_A, { status: 'running' });
    await seedNode(NODE_B, USER_B, { status: 'running' });

    // Victim workspace: owned by user A / project A, keyed on SHARED_SESSION.
    await seedWorkspace(WS_A, NODE_A, USER_A, {
      projectId: PROJECT_A,
      status: 'running',
      chatSessionId: SHARED_SESSION,
    });
    // A second workspace owned by user B / project B with its OWN distinct chat
    // session id. (The unique index forbids reusing SHARED_SESSION.) It must
    // never be returned when user A / project A resolve SHARED_SESSION, and the
    // victim's session must never resolve under B's scope.
    await seedWorkspace(WS_B, NODE_B, USER_B, {
      projectId: PROJECT_B,
      status: 'running',
      chatSessionId: SESSION_B,
    });
  });

  function db() {
    return drizzle(env.DATABASE, { schema });
  }

  it('resolves the workspace for the correct owner + project', async () => {
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_A,
      sessionId: SHARED_SESSION,
      userId: USER_A,
    });
    expect(ws).not.toBeNull();
    expect(ws?.id).toBe(WS_A);
    expect(ws?.nodeId).toBe(NODE_A);
    expect(ws?.nodeStatus).toBe('running');
  });

  it('returns null when the session id belongs to another user (IDOR guard)', async () => {
    // User B requesting with project B but using a session id whose victim row
    // is owned by A — and querying A's session against B's scope must fail.
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_A,
      sessionId: SHARED_SESSION,
      userId: USER_B,
    });
    expect(ws).toBeNull();
  });

  it('returns null when the session id belongs to another project (IDOR guard)', async () => {
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_B,
      sessionId: SHARED_SESSION,
      userId: USER_A,
    });
    expect(ws).toBeNull();
  });

  it('returns null for an unknown session id', async () => {
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_A,
      sessionId: `${PREFIX}-does-not-exist`,
      userId: USER_A,
    });
    expect(ws).toBeNull();
  });

  it('returns null when the workspace is not in an active status', async () => {
    const stoppedSession = `${PREFIX}-stopped-session`;
    const stoppedWs = `${PREFIX}-wsStopped`;
    await seedWorkspace(stoppedWs, NODE_A, USER_A, {
      projectId: PROJECT_A,
      status: 'stopped',
      chatSessionId: stoppedSession,
    });
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_A,
      sessionId: stoppedSession,
      userId: USER_A,
    });
    expect(ws).toBeNull();
  });

  it('resolves a workspace in recovery status (active state)', async () => {
    // 'recovery' is an active state accepted by the resolver's status filter
    // (inArray(status, ['running', 'recovery'])). A workspace mid-recovery must
    // still be resolvable so the chat bridge can drive its VM agent.
    const recoverySession = `${PREFIX}-recovery-session`;
    const recoveryWs = `${PREFIX}-wsRecovery`;
    await seedWorkspace(recoveryWs, NODE_A, USER_A, {
      projectId: PROJECT_A,
      status: 'recovery',
      chatSessionId: recoverySession,
    });
    const ws = await resolveLiveWorkspaceForSession(db(), {
      projectId: PROJECT_A,
      sessionId: recoverySession,
      userId: USER_A,
    });
    expect(ws).not.toBeNull();
    expect(ws?.id).toBe(recoveryWs);
    expect(ws?.nodeId).toBe(NODE_A);
  });
});
