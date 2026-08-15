import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  claimSessionSnapshotRecovery,
  claimSessionSnapshotSleep,
  completeSessionSnapshot,
  ensureSessionSnapshotForSleep,
  getRestorableSessionSnapshot,
  markSessionSnapshotSleeping,
  prepareSessionSnapshot,
  type SessionSnapshotManifest,
  verifyRestorableSessionSnapshotArtifacts,
} from '../../src/services/session-snapshots';

const TEST_PREFIX = `snapshot-${Date.now()}`;

describe('session snapshot D1/R2 worker wiring', () => {
  it('creates a pending lifecycle row that an explicit sleep can claim before the first checkpoint completes', async () => {
    const userId = `${TEST_PREFIX}-sleep-user`;
    const nodeId = `${TEST_PREFIX}-sleep-node`;
    const workspaceId = `${TEST_PREFIX}-sleep-workspace`;
    const chatSessionId = `${TEST_PREFIX}-sleep-chat`;
    const agentSessionId = `${TEST_PREFIX}-sleep-agent-session`;
    const bindings = {
      ...env,
      SESSION_SNAPSHOT_R2_PREFIX: `${TEST_PREFIX}/sleep-snapshots`,
    } as unknown as Env;
    const db = drizzle(env.DATABASE, { schema });

    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(userId, `${userId}@example.com`, 'Sleep User', Date.now(), Date.now())
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, runtime, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'small', 'local', 'vm', datetime('now'), datetime('now'))`
    )
      .bind(nodeId, userId, 'sleep-node')
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO workspaces (id, node_id, user_id, name, repository, branch, status, vm_size, vm_location, chat_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'main', 'running', 'small', 'local', ?, datetime('now'), datetime('now'))`
    )
      .bind(workspaceId, nodeId, userId, 'sleep-workspace', 'owner/repo', chatSessionId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'running', datetime('now'), datetime('now'))`
    )
      .bind(agentSessionId, workspaceId, userId)
      .run();

    await ensureSessionSnapshotForSleep(db, bindings, {
      workspaceId,
      nodeId,
      projectId: null,
      userId,
      chatSessionId,
      agentSessionId,
      runtime: 'vm',
    });

    const pending = await env.DATABASE.prepare(
      `SELECT status, degradation, sleep_status, capture_generation
       FROM session_snapshots WHERE chat_session_id = ?`
    )
      .bind(chatSessionId)
      .first<Record<string, unknown>>();
    expect(pending).toMatchObject({
      status: 'pending',
      degradation: 'none',
      sleep_status: null,
      capture_generation: null,
    });

    await expect(
      claimSessionSnapshotSleep(db, bindings, {
        chatSessionId,
        claimId: `${TEST_PREFIX}-sleep-claim`,
        force: true,
      })
    ).resolves.toEqual({
      status: 'claimed',
      claimId: `${TEST_PREFIX}-sleep-claim`,
      phase: 'preparing',
    });
  });

  it('creates one restorable snapshot per chat session and writes the manifest to R2', async () => {
    const userId = `${TEST_PREFIX}-user`;
    const nodeId = `${TEST_PREFIX}-node`;
    const workspaceId = `${TEST_PREFIX}-workspace`;
    const chatSessionId = `${TEST_PREFIX}-chat`;
    const agentSessionId = `${TEST_PREFIX}-agent-session`;
    const bindings = {
      ...env,
      SESSION_SNAPSHOT_R2_PREFIX: `${TEST_PREFIX}/snapshots`,
      SESSION_SNAPSHOT_TTL_DAYS: '7',
    } as unknown as Env;
    const db = drizzle(env.DATABASE, { schema });

    await env.DATABASE.prepare(
      `INSERT INTO users (id, email, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(userId, `${userId}@example.com`, 'Snapshot User', Date.now(), Date.now())
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO nodes (id, user_id, name, status, vm_size, vm_location, runtime, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 'small', 'local', 'cf-container', datetime('now'), datetime('now'))`
    )
      .bind(nodeId, userId, 'snapshot-node')
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO workspaces (id, node_id, user_id, name, repository, branch, status, vm_size, vm_location, chat_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'main', 'sleeping', 'small', 'local', ?, datetime('now'), datetime('now'))`
    )
      .bind(workspaceId, nodeId, userId, 'snapshot-workspace', 'owner/repo', chatSessionId)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'sleeping', datetime('now'), datetime('now'))`
    )
      .bind(agentSessionId, workspaceId, userId)
      .run();

    const prepared = await prepareSessionSnapshot(db, bindings, {
      workspaceId,
      nodeId,
      projectId: null,
      userId,
      chatSessionId,
      agentSessionId,
      runtime: 'cf-container',
    });

    expect(prepared.generation).toMatch(/^[0-9A-Z]{26}$/);
    expect(prepared.keys.home).toBe(
      `${TEST_PREFIX}/snapshots/${chatSessionId}/${prepared.generation}/home.tar`
    );
    expect(prepared.config.ttlDays).toBe(7);

    const homeSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('home'))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const wipSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('wip'))),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const manifest: SessionSnapshotManifest = {
      version: 1,
      chatSessionId,
      workspaceId,
      agentSessionId,
      acpSessionId: 'acp-session-1',
      agentType: 'openai-codex',
      baseCommit: 'base-commit',
      status: 'available',
      degradation: 'none',
      skipped: [],
      artifacts: {
        home: { sizeBytes: 4, sha256: homeSha256 },
        wip: { sizeBytes: 3, sha256: wipSha256 },
      },
      createdAt: new Date().toISOString(),
    };

    await env.R2.put(prepared.keys.home, 'home', { sha256: homeSha256 });
    await env.R2.put(prepared.keys.wip, 'wip', { sha256: wipSha256 });
    await completeSessionSnapshot(db, bindings, {
      workspaceId,
      chatSessionId,
      agentSessionId,
      runtime: 'cf-container',
      baseCommit: 'base-commit',
      status: 'available',
      degradation: 'none',
      captureGeneration: prepared.generation,
      manifest,
      artifactSizes: {
        homeBytes: 4,
        wipBytes: 3,
      },
      artifactSha256: { homeSha256, wipSha256 },
    });

    const restorable = await getRestorableSessionSnapshot(db, chatSessionId);
    expect(restorable).toMatchObject({
      chatSessionId,
      workspaceId,
      status: 'available',
      degradation: 'none',
      homeR2Key: prepared.keys.home,
      wipR2Key: prepared.keys.wip,
      manifestR2Key: prepared.keys.manifest,
      baseCommit: 'base-commit',
      snapshotGeneration: prepared.generation,
      captureGeneration: null,
      homeSha256,
      wipSha256,
    });
    if (!restorable) throw new Error('snapshot was not restorable');
    await expect(verifyRestorableSessionSnapshotArtifacts(bindings, restorable)).resolves.toBe(
      true
    );

    const manifestObject = await env.R2.get(prepared.keys.manifest);
    expect(manifestObject).not.toBeNull();
    if (!manifestObject) throw new Error('snapshot manifest was not written to R2');
    await expect(manifestObject.json()).resolves.toMatchObject({
      chatSessionId,
      workspaceId,
      acpSessionId: 'acp-session-1',
      agentType: 'openai-codex',
      artifacts: {
        home: { sizeBytes: 4 },
        wip: { sizeBytes: 3 },
      },
    });

    const nextCapture = await prepareSessionSnapshot(db, bindings, {
      workspaceId,
      nodeId,
      projectId: null,
      userId,
      chatSessionId,
      agentSessionId,
      runtime: 'cf-container',
    });
    const preserved = await getRestorableSessionSnapshot(db, chatSessionId);
    expect(nextCapture.generation).not.toBe(prepared.generation);
    expect(preserved).toMatchObject({
      status: 'available',
      snapshotGeneration: prepared.generation,
      captureGeneration: nextCapture.generation,
      homeR2Key: prepared.keys.home,
      manifestR2Key: prepared.keys.manifest,
      homeSha256,
    });

    expect(await markSessionSnapshotSleeping(db, bindings, chatSessionId)).toBe(true);
    const [firstClaim, concurrentClaim] = await Promise.all([
      claimSessionSnapshotRecovery(db, bindings, {
        chatSessionId,
        userId,
        taskId: `${TEST_PREFIX}-wake-a`,
      }),
      claimSessionSnapshotRecovery(db, bindings, {
        chatSessionId,
        userId,
        taskId: `${TEST_PREFIX}-wake-b`,
      }),
    ]);
    const claimed = [firstClaim, concurrentClaim].find((claim) => claim.status === 'claimed');
    const waking = [firstClaim, concurrentClaim].find((claim) => claim.status === 'waking');
    expect(claimed?.status).toBe('claimed');
    expect(waking).toEqual({ status: 'waking', taskId: claimed?.taskId });

    const reclaimed = await claimSessionSnapshotRecovery(db, bindings, {
      chatSessionId,
      userId,
      taskId: `${TEST_PREFIX}-wake-reclaimed`,
      now: new Date(Date.now() + 11 * 60 * 1000),
    });
    expect(reclaimed).toEqual({
      status: 'claimed',
      taskId: `${TEST_PREFIX}-wake-reclaimed`,
    });
  });
});
