import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { terminalizeIdleTaskInD1 } from '../../src/durable-objects/project-data/idle-cleanup-terminalization';
import type { Env } from '../../src/env';
import { runSessionSleepLifecycleRepair } from '../../src/scheduled/session-sleep-lifecycle-repair';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

describe('confirmed sleep retires obsolete idle cleanup only for its exact owner', () => {
  it('runs the real lifecycle repair then resolves only that chat and workspace failure marker', async () => {
    const suffix = crypto.randomUUID();
    const userId = `u-${suffix}`,
      projectId = `p-${suffix}`,
      nodeId = `n-${suffix}`,
      workspaceId = `w-${suffix}`,
      taskId = `t-${suffix}`;
    await seedUser(userId);
    await seedInstallation(`i-${suffix}`, userId);
    await seedProject(projectId, userId, `i-${suffix}`);
    await seedNode(nodeId, userId, { status: 'running' });
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(projectId)
    ) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    const chatId = await stub.createSession(workspaceId, 'Half-done sleep');
    const otherChat = await stub.createSession(null, 'Other chat');
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      chatSessionId: chatId,
      status: 'running',
    });
    await seedTask(taskId, projectId, userId, {
      chatSessionId: chatId,
      workspaceId,
      status: 'in_progress',
    });
    await stub.linkSessionToTask(chatId, taskId);
    await stub.scheduleIdleCleanup(chatId, workspaceId, taskId);
    const marker = await stub.createAttentionMarker({
      sessionId: chatId,
      workspaceId,
      taskId,
      kind: 'idle_cleanup_failed',
      source: 'idle_cleanup',
      message: 'cleanup failed',
    });
    const human = await stub.createAttentionMarker({
      sessionId: chatId,
      workspaceId,
      taskId,
      kind: 'needs_input',
      source: 'request_human_input',
      message: 'human answer needed',
    });
    const other = await stub.createAttentionMarker({
      sessionId: otherChat,
      workspaceId,
      kind: 'idle_cleanup_failed',
      source: 'idle_cleanup',
      message: 'other failure',
    });
    const otherWorkspace = await stub.createAttentionMarker({
      sessionId: chatId,
      workspaceId: 'another-workspace',
      kind: 'idle_cleanup_failed',
      source: 'idle_cleanup',
      message: 'old workspace failure',
    });
    await stub.sleepSession(chatId);
    const prefix = `snapshots/${chatId}/generation`;
    const home = new TextEncoder().encode('home');
    const digest = await crypto.subtle.digest('SHA-256', home);
    const sha = Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('');
    const manifest = {
      version: 1,
      chatSessionId: chatId,
      workspaceId,
      status: 'available',
      degradation: 'none',
      artifacts: { home: { sizeBytes: home.length, sha256: sha } },
    };
    await env.R2.put(`${prefix}/home.tar`, home);
    await env.R2.put(`${prefix}/manifest.json`, JSON.stringify(manifest));
    const past = new Date(Date.now() - 3600000).toISOString();
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
      (id, project_id, workspace_id, node_id, user_id, chat_session_id, runtime, status, degradation,
       snapshot_generation, manifest_r2_key, manifest_json, home_r2_key, home_sha256, expires_at,
       sleep_status, sleep_claimed_at, sleep_stopping_since, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'vm', 'available', 'none', 'generation', ?, ?, ?, ?, ?, 'stopping', ?, ?, ?, ?)`
    )
      .bind(
        `s-${suffix}`,
        projectId,
        workspaceId,
        nodeId,
        userId,
        chatId,
        `${prefix}/manifest.json`,
        JSON.stringify(manifest),
        `${prefix}/home.tar`,
        sha,
        new Date(Date.now() + 86400000).toISOString(),
        past,
        past,
        past,
        past
      )
      .run();
    const handedOff = await runInDurableObject(stub, async (_instance, state) =>
      terminalizeIdleTaskInD1(state.storage.sql, env as unknown as Env, {
        sweep: 'session_idle_cleanup', projectId, taskId, workspaceId, sessionId: chatId,
        idleDurationMs: 3600000, timeoutMs: 300000,
      })
    );
    expect(handedOff.outcome).toBe('not_active');
    expect((await env.DATABASE.prepare('SELECT status FROM tasks WHERE id = ?').bind(taskId).first<{ status: string }>())?.status).toBe('in_progress');
    // The chat's sleeping label alone is not confirmation.
    expect(await stub.finishConfirmedSessionSleep(chatId, workspaceId)).toBe(false);
    expect(await stub.getCleanupAt(chatId)).not.toBeNull();
    await env.DATABASE.prepare("UPDATE workspaces SET status = 'sleeping' WHERE id = ?")
      .bind(workspaceId)
      .run();
    const stats = await runSessionSleepLifecycleRepair({
      ...env,
      SESSION_SNAPSHOT_R2_PREFIX: 'snapshots',
    } as unknown as Env);
    expect(stats.repaired).toBe(1);
    expect(await stub.getCleanupAt(chatId)).toBeNull();
    const markers = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.sql.exec('SELECT id, resolved_at FROM session_attention_markers').toArray()
    );
    expect(markers.find((row) => row.id === marker.id)?.resolved_at).not.toBeNull();
    for (const id of [human.id, other.id, otherWorkspace.id])
      expect(markers.find((row) => row.id === id)?.resolved_at).toBeNull();
    expect(
      (
        await env.DATABASE.prepare('SELECT status FROM tasks WHERE id = ?')
          .bind(taskId)
          .first<{ status: string }>()
      )?.status
    ).toBe('sleeping');
    expect(await stub.finishConfirmedSessionSleep(chatId, workspaceId)).toBe(true);
    const recordJson = JSON.stringify({
      outcome: 'blocked',
      blockedReason: 'teardown_unconfirmed',
    });
    const input = { snapshotId: `s-${suffix}`, chatSessionId: chatId, workspaceId, recordJson };
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_status = 'preparing', sleeping_at = NULL, sleep_fallback_json = ? WHERE id = ?"
    )
      .bind(recordJson, input.snapshotId)
      .run();
    expect(await stub.finishBlockedSessionSleep(input)).toBe(false);
    expect((await stub.getSession(chatId))?.status).toBe('sleeping');
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_status = 'terminal_failed' WHERE id = ?"
    )
      .bind(input.snapshotId)
      .run();
    await stub.wakeSession(chatId, workspaceId, taskId);
    expect(await stub.finishBlockedSessionSleep(input)).toBe(false);
    expect((await stub.getSession(chatId))?.status).toBe('active');
  });
});

// Exercise the actual public DO RPC, not a local transition or API-side guard double.
describe('sleep RPC captured runtime and stopping claim fence', () => {
  it.each(['replacement', 'claim', 'workspace_link', 'current'])('%s intent cannot sleep a successor chat', async (boundary) => {
    const suffix = crypto.randomUUID();
    const userId = `guard-u-${suffix}`, projectId = `guard-p-${suffix}`,
      nodeId = `guard-n-${suffix}`, workspaceId = `guard-w-${suffix}`;
    await seedUser(userId);
    await seedInstallation(`guard-i-${suffix}`, userId);
    await seedProject(projectId, userId, `guard-i-${suffix}`);
    await seedNode(nodeId, userId, { status: 'running' });
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(projectId)) as DurableObjectStub<ProjectData>;
    await stub.ensureProjectId(projectId);
    const chatId = await stub.createSession(workspaceId, 'Guarded sleep');
    await seedWorkspace(workspaceId, nodeId, userId, { projectId, chatSessionId: chatId, status: 'running' });
    await env.DATABASE.prepare("UPDATE workspaces SET eviction_generation='original' WHERE id=?").bind(workspaceId).run();
    await env.DATABASE.prepare(`INSERT INTO session_snapshots
      (id,project_id,workspace_id,node_id,user_id,chat_session_id,runtime,status,manifest_r2_key,expires_at,sleep_status,sleep_claim_id)
      VALUES (?,?,?,?,?,?,'vm','available','guard-manifest',?,'stopping','old-claim')`)
      .bind(`guard-s-${suffix}`,projectId,workspaceId,nodeId,userId,chatId,new Date(Date.now()+86400000).toISOString()).run();
    const options = { failedOnly: false, runtimeGuard: {
      projectId,userId,workspaceId,nodeId,evictionGeneration:'original',claimId:'old-claim',
    } };
    if (boundary === 'replacement') await env.DATABASE.prepare("UPDATE workspaces SET eviction_generation='replacement' WHERE id=?").bind(workspaceId).run();
    if (boundary === 'claim') await env.DATABASE.prepare("UPDATE session_snapshots SET sleep_claim_id='new-claim' WHERE chat_session_id=?").bind(chatId).run();
    if (boundary === 'workspace_link') await runInDurableObject(stub, async (_instance,state) => {
      state.storage.sql.exec("UPDATE chat_sessions SET workspace_id='successor-workspace' WHERE id=?",chatId);
    });
    expect(await stub.sleepSession(chatId, options)).toBe(boundary === 'current');
    expect((await stub.getSession(chatId))?.status).toBe(boundary === 'current' ? 'sleeping' : 'active');
    // Same valid intent is idempotent; refusal continues to protect the successor.
    expect(await stub.sleepSession(chatId, options)).toBe(boundary === 'current');
    expect((await stub.getSession(chatId))?.status).toBe(boundary === 'current' ? 'sleeping' : 'active');
  });
});
