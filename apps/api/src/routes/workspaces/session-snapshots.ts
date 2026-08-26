import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord, parseWithSchema } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import {
  generateSessionSnapshotDirectUploadUrl,
  sessionSnapshotDirectUploadAvailable,
} from '../../services/session-snapshot-direct-upload';
import {
  ensureSessionSnapshotUploadRelay,
  resolveSessionSnapshotUploadTargets,
  SESSION_SNAPSHOT_RELAY_AUTHORIZATION_HEADER,
  SESSION_SNAPSHOT_RELAY_NODE_ID_HEADER,
  verifySessionSnapshotRelayAuthorization,
} from '../../services/session-snapshot-upload-relay';
import {
  buildSessionSnapshotR2Key,
  completeSessionSnapshot,
  getRestorableSessionSnapshot,
  getSessionSnapshotConfig,
  prepareSessionSnapshot,
  recordSessionSnapshotArtifactAuthorization,
  recordSessionSnapshotCaptureFailure,
  recordSessionSnapshotProgress,
  recordSessionSnapshotRestoreResult,
  type SessionSnapshotArtifact,
  type SessionSnapshotDegradation,
  type SessionSnapshotManifest,
  type SessionSnapshotStatus,
} from '../../services/session-snapshots';
import { markVmAgentContainerActiveWorkEndedBestEffort } from '../../services/vm-agent-container';
import { assertWorkspaceCallbackResourceById, verifyWorkspaceCallbackAuth } from './_helpers';

const sessionSnapshotRoutes = new Hono<{ Bindings: Env }>();
type SnapshotRouteContext = Context<{ Bindings: Env }>;

const ARTIFACTS = new Set<SessionSnapshotArtifact>(['home', 'wip', 'manifest']);
const COMPLETE_STATUSES = new Set<SessionSnapshotStatus>(['available', 'degraded', 'failed']);
const DEGRADATIONS = new Set<SessionSnapshotDegradation>([
  'none',
  'home-skipped',
  'wip-skipped',
  'entries-skipped',
  'agent-context-skipped',
  'wip-only',
  'transcript-only',
]);
const SHA256_HEX = /^[a-f0-9]{64}$/;
const LEGACY_OPENCODE_GENERATED_PATH_PREFIX = '~/.config/opencode/node_modules/';

// Full structural contract for a VM-agent-submitted snapshot manifest — mirrors
// SessionSnapshotManifest in services/session-snapshots.ts field-for-field.
// This replaces a blind `as unknown as SessionSnapshotManifest` cast; identity
// (chatSessionId/workspaceId/agentSessionId match) and business-rule checks
// (artifact size vs. R2 object size) remain as separate checks below.
const SessionSnapshotArtifactEntrySchema = v.object({
  sizeBytes: v.number(),
  sha256: v.optional(v.string()),
});

const SessionSnapshotManifestSchema = v.object({
  version: v.literal(1),
  chatSessionId: v.string(),
  workspaceId: v.string(),
  agentSessionId: v.optional(v.string()),
  acpSessionId: v.optional(v.string()),
  agentType: v.optional(v.string()),
  baseCommit: v.optional(v.string()),
  status: v.picklist(['pending', 'available', 'degraded', 'failed', 'expired']),
  degradation: v.picklist([
    'none',
    'home-skipped',
    'wip-skipped',
    'entries-skipped',
    'agent-context-skipped',
    'wip-only',
    'transcript-only',
  ]),
  skipped: v.array(
    v.object({
      path: v.string(),
      reason: v.string(),
      sizeBytes: v.optional(v.number()),
    })
  ),
  artifacts: v.object({
    home: v.optional(SessionSnapshotArtifactEntrySchema),
    wip: v.optional(SessionSnapshotArtifactEntrySchema),
  }),
  createdAt: v.string(),
});

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

function artifactFromParam(value: string | undefined): SessionSnapshotArtifact {
  if (!ARTIFACTS.has(value as SessionSnapshotArtifact)) {
    throw errors.badRequest('Unknown snapshot artifact');
  }
  return value as SessionSnapshotArtifact;
}

function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) return null;
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function containsOnlyRegenerableOpenCodeSkips(manifest: SessionSnapshotManifest): boolean {
  return (
    manifest.skipped.length > 0 &&
    manifest.skipped.every(
      (entry) =>
        entry.reason === 'unsupported home entry type' &&
        entry.path.startsWith(LEGACY_OPENCODE_GENERATED_PATH_PREFIX)
    )
  );
}

async function requireWorkspace(
  c: SnapshotRouteContext,
  workspaceId: string,
  callback = 'session_snapshot'
) {
  const db = drizzle(c.env.DATABASE, { schema });
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const workspace = rows[0];
  if (!workspace) {
    await assertWorkspaceCallbackResourceById(c.env, workspaceId, callback);
    throw errors.gone('Workspace is missing; callback resource is gone');
  }
  await assertWorkspaceCallbackResourceById(c.env, workspaceId, callback);
  return { db, workspace };
}

async function requireSnapshotArtifactTarget(c: SnapshotRouteContext) {
  const workspaceId = c.req.param('id');
  if (!workspaceId) throw errors.badRequest('workspace id is required');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const artifact = artifactFromParam(c.req.param('artifact'));
  if (artifact === 'manifest') {
    throw errors.badRequest('Manifest is written by the complete endpoint');
  }
  const chatSessionId = c.req.query('chatSessionId')?.trim();
  if (!chatSessionId) throw errors.badRequest('chatSessionId is required');
  const generation = c.req.query('generation')?.trim();
  if (!generation) throw errors.badRequest('generation is required');
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_artifact');
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  return { artifact, chatSessionId, generation, db, workspace };
}

sessionSnapshotRoutes.post('/:id/session-snapshot/prepare', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_prepare');
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
  const directUploadAvailable = sessionSnapshotDirectUploadAvailable(c.env);
  const directUploadSupported = body.directUploadSupported === true;
  const uploadTargets = await resolveSessionSnapshotUploadTargets(c.env, {
    workspaceId,
    userId: workspace.userId,
    chatSessionId,
    generation: prepared.generation,
    directUploadAvailable,
    directUploadSupported,
  });
  if (uploadTargets.needsRelayProvisioning && workspace.nodeId) {
    c.executionCtx.waitUntil(
      ensureSessionSnapshotUploadRelay(c.env, {
        userId: workspace.userId,
        sourceNodeId: workspace.nodeId,
        projectId: workspace.projectId,
      }).catch((error) => {
        log.error('session_snapshot.relay_provision_failed', {
          userId: workspace.userId,
          sourceNodeId: workspace.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  return c.json({
    snapshotId: prepared.snapshotId,
    generation: prepared.generation,
    expiresAt: prepared.expiresAt,
    config: prepared.config,
    upload: uploadTargets.upload,
    directUpload: uploadTargets.directUpload,
  });
});

sessionSnapshotRoutes.post('/:id/session-snapshot/progress', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_progress');
  const body = await readJsonBody(c);
  const chatSessionId = requiredStringField(body, 'chatSessionId');
  const generation = requiredStringField(body, 'generation');
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  const recorded = await recordSessionSnapshotProgress(db, { chatSessionId, generation });
  if (!recorded) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  return c.body(null, 204);
});

sessionSnapshotRoutes.post('/:id/session-snapshot/failure', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_failure');
  const body = await readJsonBody(c);
  const chatSessionId = requiredStringField(body, 'chatSessionId');
  const generation = requiredStringField(body, 'generation');
  const error = requiredStringField(body, 'error');
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  const recorded = await recordSessionSnapshotCaptureFailure(db, c.env, {
    chatSessionId,
    generation,
    error,
  });
  if (!recorded) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  return c.body(null, 204);
});

sessionSnapshotRoutes.post('/:id/session-snapshot/artifacts/:artifact/upload-url', async (c) => {
  const { artifact, chatSessionId, generation, db, workspace } =
    await requireSnapshotArtifactTarget(c);
  await verifySessionSnapshotRelayAuthorization(
    c.env,
    workspace.userId,
    c.req.header(SESSION_SNAPSHOT_RELAY_NODE_ID_HEADER),
    c.req.header(SESSION_SNAPSHOT_RELAY_AUTHORIZATION_HEADER)
  );
  const capture = await db
    .select({ generation: schema.sessionSnapshots.captureGeneration })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!capture || capture.generation !== generation) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  const body = await readJsonBody(c);
  const sizeBytes = body.sizeBytes;
  if (
    typeof sizeBytes !== 'number' ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0 ||
    sizeBytes > getSessionSnapshotConfig(c.env).totalBudgetBytes
  ) {
    throw errors.badRequest('Snapshot artifact size is invalid');
  }
  const sha256 = requiredStringField(body, 'sha256').toLowerCase();
  if (!SHA256_HEX.test(sha256)) {
    throw errors.badRequest('Snapshot artifact SHA-256 is invalid');
  }
  const key = buildSessionSnapshotR2Key(c.env, chatSessionId, generation, artifact);
  const uploadUrl = await generateSessionSnapshotDirectUploadUrl(c.env, {
    key,
    sizeBytes,
    sha256,
    contentType: artifact === 'home' ? 'application/x-tar' : 'application/octet-stream',
    checksumHeader: body.checksumHeader === true,
  });
  const recorded = await recordSessionSnapshotArtifactAuthorization(db, {
    chatSessionId,
    generation,
    artifact,
    sizeBytes,
    sha256,
  });
  if (!recorded) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  return c.json({ uploadUrl });
});

sessionSnapshotRoutes.put('/:id/session-snapshot/artifacts/:artifact', async (c) => {
  const { artifact, chatSessionId, generation, db } = await requireSnapshotArtifactTarget(c);
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

  const capture = await db
    .select({ generation: schema.sessionSnapshots.captureGeneration })
    .from(schema.sessionSnapshots)
    .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
    .get();
  if (!capture || capture.generation !== generation) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  const sha256 = c.req.header('x-sam-content-sha256')?.trim().toLowerCase();
  if (!sha256 || !SHA256_HEX.test(sha256)) {
    throw errors.badRequest('Snapshot artifact SHA-256 is required');
  }

  const key = buildSessionSnapshotR2Key(c.env, chatSessionId, generation, artifact);
  await c.env.R2.put(key, c.req.raw.body, {
    httpMetadata: {
      contentType: artifact === 'home' ? 'application/x-tar' : 'application/octet-stream',
    },
    sha256,
  });
  return c.json({ key, artifact });
});

sessionSnapshotRoutes.post('/:id/session-snapshot/complete', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_complete');
  const body = await readJsonBody(c);
  const chatSessionId = stringField(body, 'chatSessionId');
  if (!workspace.chatSessionId || workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }

  let status = requiredStringField(body, 'status') as SessionSnapshotStatus;
  let degradation = requiredStringField(body, 'degradation') as SessionSnapshotDegradation;
  const generation = requiredStringField(body, 'generation');
  if (!COMPLETE_STATUSES.has(status)) throw errors.badRequest('Invalid snapshot status');
  if (!DEGRADATIONS.has(degradation)) throw errors.badRequest('Invalid snapshot degradation');
  const manifestRecord = expectJsonRecord(body.manifest, 'snapshot manifest');
  let manifest: SessionSnapshotManifest;
  try {
    manifest = parseWithSchema(
      SessionSnapshotManifestSchema,
      manifestRecord,
      'session snapshot manifest'
    );
  } catch {
    throw errors.badRequest('Snapshot manifest is invalid');
  }
  if (
    manifest.version !== 1 ||
    manifest.chatSessionId !== chatSessionId ||
    manifest.workspaceId !== workspaceId
  ) {
    throw errors.badRequest('Snapshot manifest identity does not match request');
  }
  if (manifest.status !== status || manifest.degradation !== degradation) {
    throw errors.badRequest('Snapshot manifest lifecycle does not match request');
  }
  if (
    (status === 'available' && degradation !== 'none') ||
    (status !== 'available' && degradation === 'none')
  ) {
    throw errors.badRequest('Snapshot lifecycle status and degradation are inconsistent');
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
  if (
    status === 'available' &&
    (acpSessionId === null || agentType === null || manifest.skipped.length > 0)
  ) {
    throw errors.badRequest('Complete snapshots require harness identity and no skipped state');
  }
  if (status === 'available' && !('home' in manifestArtifacts)) {
    throw errors.badRequest('Complete snapshots require the state archive');
  }
  const authorization = await db
    .select({
      authorizedHomeBytes: schema.sessionSnapshots.authorizedHomeBytes,
      authorizedHomeSha256: schema.sessionSnapshots.authorizedHomeSha256,
      authorizedWipBytes: schema.sessionSnapshots.authorizedWipBytes,
      authorizedWipSha256: schema.sessionSnapshots.authorizedWipSha256,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
        eq(schema.sessionSnapshots.captureGeneration, generation)
      )
    )
    .get();
  if (!authorization) {
    throw errors.conflict('Snapshot capture generation is no longer current');
  }
  const artifactSizes: { homeBytes?: number; wipBytes?: number } = {};
  const artifactSha256: { homeSha256?: string; wipSha256?: string } = {};
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
    const claimedSha256 =
      typeof artifactRecord.sha256 === 'string' ? artifactRecord.sha256.toLowerCase() : '';
    if (!SHA256_HEX.test(claimedSha256)) {
      throw errors.badRequest('Snapshot ' + artifact + ' SHA-256 is invalid');
    }
    const object = await c.env.R2.head(
      buildSessionSnapshotR2Key(c.env, chatSessionId, generation, artifact)
    );
    if (!object) throw errors.badRequest('Snapshot ' + artifact + ' artifact is missing');
    if (object.size !== claimedSize)
      throw errors.badRequest('Snapshot ' + artifact + ' size does not match upload');
    const uploadedSha256 = checksumHex(object.checksums.sha256);
    if (uploadedSha256 !== null) {
      if (uploadedSha256 !== claimedSha256) {
        throw errors.badRequest('Snapshot ' + artifact + ' SHA-256 does not match upload');
      }
    } else {
      const authorizedSize =
        artifact === 'home' ? authorization.authorizedHomeBytes : authorization.authorizedWipBytes;
      const authorizedSha256 =
        artifact === 'home'
          ? authorization.authorizedHomeSha256
          : authorization.authorizedWipSha256;
      if (authorizedSize == null || authorizedSha256 == null) {
        throw errors.badRequest(
          'Snapshot ' +
            artifact +
            ' SHA-256 is absent from upload and no authorized checksum was recorded'
        );
      }
      if (authorizedSize !== claimedSize) {
        throw errors.badRequest('Snapshot ' + artifact + ' size does not match authorized upload');
      }
      if (authorizedSha256.toLowerCase() !== claimedSha256) {
        throw errors.badRequest(
          'Snapshot ' + artifact + ' SHA-256 does not match authorized upload'
        );
      }
    }
    artifactSizes[sizeKey] = object.size;
    artifactSha256[artifact === 'home' ? 'homeSha256' : 'wipSha256'] = claimedSha256;
  }
  const totalArtifactBytes = (artifactSizes.homeBytes ?? 0) + (artifactSizes.wipBytes ?? 0);
  if (totalArtifactBytes > getSessionSnapshotConfig(c.env).totalBudgetBytes) {
    throw errors.badRequest('Snapshot artifacts exceed configured total budget');
  }
  if (
    status === 'degraded' &&
    degradation === 'entries-skipped' &&
    'home' in manifestArtifacts &&
    containsOnlyRegenerableOpenCodeSkips(manifest)
  ) {
    status = 'available';
    degradation = 'none';
    manifest = { ...manifest, status, degradation, skipped: [] };
  }

  await completeSessionSnapshot(db, c.env, {
    workspaceId,
    chatSessionId,
    agentSessionId,
    runtime: stringField(body, 'runtime', false) || 'runtime-neutral',
    baseCommit: stringField(body, 'baseCommit', false),
    captureGeneration: generation,
    status,
    degradation,
    manifest,
    artifactSizes,
    artifactSha256,
  });

  await markVmAgentContainerActiveWorkEndedBestEffort(
    c.env,
    workspace.nodeId,
    'session_snapshot_complete'
  );

  return c.json({ status, degradation });
});

sessionSnapshotRoutes.get('/:id/session-snapshot/restore', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(c, workspaceId, 'session_snapshot_restore');
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
  const { db, workspace } = await requireWorkspace(
    c,
    workspaceId,
    'session_snapshot_artifact_download'
  );
  if (workspace.chatSessionId !== chatSessionId) {
    throw errors.forbidden('Snapshot chat session does not match workspace');
  }
  const snapshot = await getRestorableSessionSnapshot(db, chatSessionId);
  const key =
    artifact === 'home'
      ? snapshot?.homeR2Key
      : artifact === 'wip'
        ? snapshot?.wipR2Key
        : snapshot?.manifestR2Key;
  if (!key) throw errors.notFound('Snapshot artifact');
  const object = await c.env.R2.get(key);
  if (!object) throw errors.notFound('Snapshot artifact');
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
});

sessionSnapshotRoutes.post('/:id/session-snapshot/restore-result', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);
  const { db, workspace } = await requireWorkspace(
    c,
    workspaceId,
    'session_snapshot_restore_result'
  );
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
