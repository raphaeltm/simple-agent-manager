import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import {
  completeSessionSnapshot,
  getRestorableSessionSnapshot,
  prepareSessionSnapshot,
  type SessionSnapshotManifest,
} from '../../src/services/session-snapshots';

const TEST_PREFIX = `snapshot-${Date.now()}`;

describe('session snapshot D1/R2 worker wiring', () => {
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

    expect(prepared.keys.home).toBe(`${TEST_PREFIX}/snapshots/${chatSessionId}/home.tar`);
    expect(prepared.config.ttlDays).toBe(7);

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
        home: { sizeBytes: 4 },
        wip: { sizeBytes: 3 },
      },
      createdAt: new Date().toISOString(),
    };

    await env.R2.put(prepared.keys.home, 'home');
    await env.R2.put(prepared.keys.wip, 'wip');
    await completeSessionSnapshot(db, bindings, {
      workspaceId,
      chatSessionId,
      agentSessionId,
      runtime: 'cf-container',
      baseCommit: 'base-commit',
      status: 'available',
      degradation: 'none',
      manifest,
      artifactSizes: {
        homeBytes: 4,
        wipBytes: 3,
      },
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
    });

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
  });
});
