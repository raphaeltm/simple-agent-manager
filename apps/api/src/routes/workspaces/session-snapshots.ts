import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import {
  buildSessionSnapshotR2Key,
  completeSessionSnapshot,
  getRestorableSessionSnapshot,
  getSessionSnapshotConfig,
  prepareSessionSnapshot,
  recordSessionSnapshotRestoreResult,
  type SessionSnapshotArtifact,
  type SessionSnapshotDegradation,
  type SessionSnapshotManifest,
  type SessionSnapshotStatus,
} from '../../services/session-snapshots';
import { verifyWorkspaceCallbackAuth } from './_helpers';

const sessionSnapshotRoutes = new Hono<{ Bindings: Env }>();
type SnapshotRouteContext = Context<{ Bindings: Env }>;

const ARTIFACTS = new Set<SessionSnapshotArtifact>(['home', 'wip', 'manifest']);
const COMPLETE_STATUSES = new Set<SessionSnapshotStatus>(['available', 'degraded', 'failed']);
const DEGRADATIONS = new Set<SessionSnapshotDegradation>([
  'none',
  'home-skipped',
  'wip-only',
  'transcript-only',
]);

async function readJsonBody(c: SnapshotRouteContext) {
  const raw = await c.req.raw.text();
  if (new TextEncoder().encode(raw).byteLength > getSessionSnapshotConfig(c.env).jsonBodyMaxBytes) {
    throw errors.badRequest('Snapshot request body is too large');
  }
  try {
    return expectJsonRecord(JSON.parse(raw), 'session snapshot request');
  } catch {
    throw errors.badRequest('Invalid JSON request body');
  }
}

function stringField(body: Record<string, unknown>, key: string, required = true): string | null {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    if (required) throw errors.badRequest(`${key} is required`);
    return null;
  }
  return value.trim();
}

function optionalStringField(body: Record<string, unknown>, key: string): string | null {
  if (!(key in body) || body[key] === null || body[key] === undefined) return null;
  return requiredStringField(body, key);
}

function requiredStringField(body: Record<string, unknown>, key: string): string {
  const value = stringField(body, key, true);
  if (value === null) throw errors.badRequest(`${key} is required`);
  return value;
}

function artifactFromParam(value: string): SessionSnapshotArtifact {
  if (!ARTIFACTS.has(value as SessionSnapshotArtifact)) {
    throw errors.badRequest('Unknown snapshot artifact');
  }
  return value as SessionSnapshotArtifact;
}

async function requireWorkspace(c: SnapshotRouteContext, workspaceId: string) {
  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) throw errors.notFound('Workspace');
  return { db, workspace };
}

sessionSnapshotRoutes.post('/:id/session-snapshot/prepare', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId);
  const body = await readJsonBody(c);
  const chatSessionId = requiredStringField(body, 'chatSessionId');
  const agentSessionId = stringField(body, 'agentSessionId', false);
  const runtime = stringField(body, 'runtime', false) || 'runtime-neutral';

  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }

  const prepared = await prepareSessionSnapshot(db, c.env, {
    workspaceId,
    nodeId: workspace.nodeId,
    projectId: workspace.projectId,
    userId: workspace.userId,
    chatSessionId,
    agentSessionId,
    runtime,
  });

  return c.json({
    snapshotId: prepared.snapshotId,
    expiresAt: prepared.expiresAt,
    config: prepared.config,
    upload: {
      home: `/api/workspaces/${workspaceId}/session-snapshot/artifacts/home?chatSessionId=${encodeURIComponent(chatSessionId)}`,
      wip: `/api/workspaces/${workspaceId}/session-snapshot/artifacts/wip?chatSessionId=${encodeURIComponent(chatSessionId)}`,
    },
  });
});

sessionSnapshotRoutes.put('/:id/session-snapshot/artifacts/:artifact', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const artifact = artifactFromParam(c.req.param('artifact'));
  if (artifact === 'manifest') {
    throw errors.badRequest('Manifest is written by the complete endpoint');
  }
  const chatSessionId = c.req.query('chatSessionId')?.trim();
  if (!chatSessionId) throw errors.badRequest('chatSessionId is required');
  const { workspace } = await requireWorkspace(c, workspaceId);
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  const contentLength = c.req.header('content-length');
  if (!contentLength) throw errors.badRequest('Snapshot artifact Content-Length is required');
  {
    const parsed = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(parsed) || parsed < 0) throw errors.badRequest('Invalid Content-Length');
    if (parsed > getSessionSnapshotConfig(c.env).totalBudgetBytes) {
      throw errors.badRequest('Snapshot artifact exceeds configured total budget');
    }
  }
  if (!c.req.raw.body) throw errors.badRequest('Snapshot artifact body is required');

  const key = buildSessionSnapshotR2Key(c.env, chatSessionId, artifact);
  await c.env.R2.put(key, c.req.raw.body, {
    httpMetadata: {
      contentType: artifact === 'home' ? 'application/x-tar' : 'application/octet-stream',
    },
  });
  return c.json({ key, artifact });
});

sessionSnapshotRoutes.post('/:id/session-snapshot/complete', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId);
  const body = await readJsonBody(c);
  const chatSessionId = stringField(body, 'chatSessionId');
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }

  const status = requiredStringField(body, 'status') as SessionSnapshotStatus;
  const degradation = requiredStringField(body, 'degradation') as SessionSnapshotDegradation;
  if (!COMPLETE_STATUSES.has(status)) throw errors.badRequest('Invalid snapshot status');
  if (!DEGRADATIONS.has(degradation)) throw errors.badRequest('Invalid snapshot degradation');
  const manifestRecord = expectJsonRecord(body.manifest, 'snapshot manifest');
  const manifest = manifestRecord as unknown as SessionSnapshotManifest;
  if (
    manifest.version !== 1 ||
    manifest.chatSessionId !== chatSessionId ||
    manifest.workspaceId !== workspaceId
  ) {
    throw errors.badRequest('Snapshot manifest identity does not match request');
  }
  const agentSessionId = optionalStringField(body, 'agentSessionId');
  const manifestAgentSessionId = optionalStringField(manifestRecord, 'agentSessionId');
  if (manifestAgentSessionId !== agentSessionId) {
    throw errors.badRequest('Snapshot agent session does not match request');
  }
  const acpSessionId = optionalStringField(manifestRecord, 'acpSessionId');
  const agentType = optionalStringField(manifestRecord, 'agentType');
  if ((acpSessionId === null) !== (agentType === null)) {
    throw errors.badRequest('Snapshot agent context identity is incomplete');
  }
  const manifestArtifacts = expectJsonRecord(
    manifestRecord.artifacts ?? {},
    'snapshot manifest artifacts'
  );
  const artifactSizes: { homeBytes?: number; wipBytes?: number } = {};
  for (const [artifact, sizeKey] of [
    ['home', 'homeBytes'],
    ['wip', 'wipBytes'],
  ] as const) {
    if (!(artifact in manifestArtifacts)) continue;
    const artifactRecord = expectJsonRecord(
      manifestArtifacts[artifact],
      'snapshot ' + artifact + ' artifact'
    );
    const claimedSize = artifactRecord.sizeBytes;
    if (typeof claimedSize !== 'number' || !Number.isSafeInteger(claimedSize) || claimedSize < 0) {
      throw errors.badRequest('Snapshot ' + artifact + ' size is invalid');
    }
    const object = await c.env.R2.head(buildSessionSnapshotR2Key(c.env, chatSessionId, artifact));
    if (!object) throw errors.badRequest('Snapshot ' + artifact + ' artifact is missing');
    if (object.size !== claimedSize)
      throw errors.badRequest('Snapshot ' + artifact + ' size does not match upload');
    artifactSizes[sizeKey] = object.size;
  }
  const totalArtifactBytes = (artifactSizes.homeBytes ?? 0) + (artifactSizes.wipBytes ?? 0);
  if (totalArtifactBytes > getSessionSnapshotConfig(c.env).totalBudgetBytes) {
    throw errors.badRequest('Snapshot artifacts exceed configured total budget');
  }

  await completeSessionSnapshot(db, c.env, {
    workspaceId,
    chatSessionId,
    agentSessionId,
    runtime: stringField(body, 'runtime', false) || 'runtime-neutral',
    baseCommit: stringField(body, 'baseCommit', false),
    status,
    degradation,
    manifest,
    artifactSizes,
  });

  return c.json({ status, degradation });
});

sessionSnapshotRoutes.get('/:id/session-snapshot/restore', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId);
  const chatSessionId = c.req.query('chatSessionId')?.trim() || workspace.chatSessionId;
  if (!chatSessionId) throw errors.badRequest('chatSessionId is required');
  if (workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }

  const snapshot = await getRestorableSessionSnapshot(db, chatSessionId);
  if (!snapshot) {
    return c.json({ available: false, reason: 'snapshot_missing_or_unavailable' });
  }

  return c.json({
    available: true,
    status: snapshot.status,
    degradation: snapshot.degradation,
    baseCommit: snapshot.baseCommit,
    manifest: snapshot.manifestJson ? JSON.parse(snapshot.manifestJson) : null,
    config: getSessionSnapshotConfig(c.env),
    download: {
      home: snapshot.homeR2Key
        ? `/api/workspaces/${workspaceId}/session-snapshot/artifacts/home?chatSessionId=${encodeURIComponent(chatSessionId)}`
        : null,
      wip: snapshot.wipR2Key
        ? `/api/workspaces/${workspaceId}/session-snapshot/artifacts/wip?chatSessionId=${encodeURIComponent(chatSessionId)}`
        : null,
      manifest: `/api/workspaces/${workspaceId}/session-snapshot/artifacts/manifest?chatSessionId=${encodeURIComponent(chatSessionId)}`,
    },
  });
});

sessionSnapshotRoutes.get('/:id/session-snapshot/artifacts/:artifact', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const artifact = artifactFromParam(c.req.param('artifact'));
  const chatSessionId = c.req.query('chatSessionId')?.trim();
  if (!chatSessionId) throw errors.badRequest('chatSessionId is required');
  const { workspace } = await requireWorkspace(c, workspaceId);
  if (workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  const object = await c.env.R2.get(buildSessionSnapshotR2Key(c.env, chatSessionId, artifact));
  if (!object) throw errors.notFound('Snapshot artifact');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
});

sessionSnapshotRoutes.post('/:id/session-snapshot/restore-result', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId);
  const body = await readJsonBody(c);
  const chatSessionId = requiredStringField(body, 'chatSessionId');
  if (workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  await recordSessionSnapshotRestoreResult(db, {
    chatSessionId,
    status: requiredStringField(body, 'status'),
    message: stringField(body, 'message', false),
  });
  return c.body(null, 204);
});

export { sessionSnapshotRoutes };
