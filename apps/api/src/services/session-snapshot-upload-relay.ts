import type { CredentialProvider, CredentialSource } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { errors } from '../middleware/error';
import { verifyCallbackToken } from './jwt';
import { getRuntimeLimits } from './limits';
import { getNodeBackendBaseUrl } from './node-agent-readiness';

const RELAY_NODE_NAME_PREFIX = 'Session snapshot relay';

type RelayNode = {
  id: string;
  name: string;
};

export const SESSION_SNAPSHOT_RELAY_NODE_ID_HEADER = 'X-SAM-Relay-Node-ID';
export const SESSION_SNAPSHOT_RELAY_AUTHORIZATION_HEADER = 'X-SAM-Relay-Authorization';

function relayNodeName(requiredVersion: string): string {
  return `${RELAY_NODE_NAME_PREFIX} ${requiredVersion.slice(0, 12)}`;
}

export async function findSessionSnapshotUploadRelay(
  env: Env,
  userId: string
): Promise<RelayNode | null> {
  const requiredVersion = env.VM_AGENT_REQUIRED_VERSION?.trim();
  if (!requiredVersion) return null;

  const relay = await env.DATABASE.prepare(
    `SELECT id, name
       FROM nodes
      WHERE user_id = ?
        AND status = 'running'
        AND health_status = 'healthy'
        AND agent_version = ?
        AND node_role = 'workspace'
        AND node_class != 'user-owned'
        AND (runtime IS NULL OR runtime = 'vm')
      ORDER BY CASE WHEN warm_since IS NOT NULL THEN 0 ELSE 1 END, created_at ASC
      LIMIT 1`
  )
    .bind(userId, requiredVersion)
    .first<RelayNode>();

  return relay ?? null;
}

export function buildSessionSnapshotRelayUploadUrl(
  env: Env,
  relayNodeId: string,
  authorizationPath: string
): string {
  const url = new URL(`${getNodeBackendBaseUrl(relayNodeId, env)}/session-snapshot-upload-relay`);
  url.searchParams.set('authorizationPath', authorizationPath);
  return url.toString();
}

/**
 * A relay authorization request carries two independent credentials: the
 * legacy workspace bearer in Authorization and the current relay node's
 * node-scoped bearer in the headers below. This prevents a workspace token
 * holder from using another tenant's VM as an unauthenticated upload proxy.
 */
export async function verifySessionSnapshotRelayAuthorization(
  env: Env,
  workspaceUserId: string,
  relayNodeIdHeader: string | undefined,
  relayAuthorizationHeader: string | undefined
): Promise<void> {
  const relayNodeId = relayNodeIdHeader?.trim() ?? '';
  const relayAuthorization = relayAuthorizationHeader?.trim() ?? '';
  if (!relayNodeId && !relayAuthorization) return;
  if (!relayNodeId || !relayAuthorization) {
    throw errors.forbidden('Invalid snapshot relay authorization');
  }

  let relayToken: string;
  try {
    relayToken = extractBearerToken(relayAuthorization);
  } catch {
    throw errors.forbidden('Invalid snapshot relay authorization');
  }

  try {
    const payload = await verifyCallbackToken(relayToken, env, { expectedScope: 'node' });
    if (payload.scope !== 'node' || payload.workspace !== relayNodeId) {
      throw new Error('Relay token does not match node');
    }
  } catch {
    throw errors.forbidden('Invalid snapshot relay authorization');
  }

  const requiredVersion = env.VM_AGENT_REQUIRED_VERSION?.trim();
  if (!requiredVersion) {
    throw errors.forbidden('Invalid snapshot relay authorization');
  }
  const relay = await env.DATABASE.prepare(
    `SELECT id
       FROM nodes
      WHERE id = ?
        AND user_id = ?
        AND status = 'running'
        AND health_status = 'healthy'
        AND agent_version = ?
        AND node_role = 'workspace'
        AND node_class != 'user-owned'
        AND (runtime IS NULL OR runtime = 'vm')
      LIMIT 1`
  )
    .bind(relayNodeId, workspaceUserId, requiredVersion)
    .first<{ id: string }>();
  if (!relay) {
    throw errors.forbidden('Invalid snapshot relay authorization');
  }
}

function snapshotUploadAuthorizationPath(input: {
  workspaceId: string;
  chatSessionId: string;
  generation: string;
  artifact: 'home' | 'wip';
}): string {
  return `/api/workspaces/${input.workspaceId}/session-snapshot/artifacts/${input.artifact}/upload-url?chatSessionId=${encodeURIComponent(input.chatSessionId)}&generation=${encodeURIComponent(input.generation)}`;
}

export async function resolveSessionSnapshotUploadTargets(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    chatSessionId: string;
    generation: string;
    directUploadAvailable: boolean;
    directUploadSupported: boolean;
  }
): Promise<{
  upload: { home: string; wip: string };
  directUpload?: { home: string; wip: string };
  needsRelayProvisioning: boolean;
}> {
  const relay =
    input.directUploadAvailable && !input.directUploadSupported
      ? await findSessionSnapshotUploadRelay(env, input.userId)
      : null;
  const target = (artifact: 'home' | 'wip'): string => {
    const authorizationPath = snapshotUploadAuthorizationPath({ ...input, artifact });
    if (relay) return buildSessionSnapshotRelayUploadUrl(env, relay.id, authorizationPath);
    return `/api/workspaces/${input.workspaceId}/session-snapshot/artifacts/${artifact}?chatSessionId=${encodeURIComponent(input.chatSessionId)}&generation=${encodeURIComponent(input.generation)}`;
  };
  const authorizationTarget = (artifact: 'home' | 'wip'): string =>
    snapshotUploadAuthorizationPath({ ...input, artifact });

  return {
    upload: { home: target('home'), wip: target('wip') },
    directUpload: input.directUploadAvailable
      ? { home: authorizationTarget('home'), wip: authorizationTarget('wip') }
      : undefined,
    needsRelayProvisioning:
      input.directUploadAvailable && !input.directUploadSupported && relay === null,
  };
}

/**
 * Provision one current-generation replacement node when a legacy busy node
 * cannot upload its snapshot through the Worker's request-body limit. The node
 * is immediately placed in the normal warm pool after provisioning, so it can
 * relay the legacy upload and then remain available for fast task pickup using
 * the existing retention policy.
 */
export async function ensureSessionSnapshotUploadRelay(
  env: Env,
  input: { userId: string; sourceNodeId: string; projectId: string | null }
): Promise<void> {
  const requiredVersion = env.VM_AGENT_REQUIRED_VERSION?.trim();
  if (!requiredVersion) return;
  if (await findSessionSnapshotUploadRelay(env, input.userId)) return;

  const name = relayNodeName(requiredVersion);
  const existing = await env.DATABASE.prepare(
    `SELECT id
       FROM nodes
      WHERE user_id = ? AND name = ? AND status IN ('creating', 'running', 'error')
      LIMIT 1`
  )
    .bind(input.userId, name)
    .first<{ id: string }>();
  if (existing) return;

  const source = await env.DATABASE.prepare(
    `SELECT id, user_id, vm_size, vm_location, cloud_provider, runtime, node_class,
            agent_version, credential_attribution_user_id,
            credential_attribution_project_id, credential_attribution_source
       FROM nodes
      WHERE id = ? AND user_id = ? AND status = 'running'
      LIMIT 1`
  )
    .bind(input.sourceNodeId, input.userId)
    .first<{
      id: string;
      user_id: string;
      vm_size: string;
      vm_location: string;
      cloud_provider: string | null;
      runtime: string | null;
      node_class: string;
      agent_version: string | null;
      credential_attribution_user_id: string | null;
      credential_attribution_project_id: string | null;
      credential_attribution_source: string | null;
    }>();
  if (
    !source ||
    source.runtime === 'cf-container' ||
    source.node_class === 'user-owned' ||
    source.agent_version === requiredVersion
  ) {
    return;
  }

  // The versioned name above bounds this to one rollout replacement. It is
  // intentionally allowed beyond the normal node count: incompatible nodes
  // cannot accept work and counting them would deadlock their own drain.
  const limits = getRuntimeLimits(env);
  const attributionUserId = source.credential_attribution_user_id ?? input.userId;
  const attributionSource: CredentialSource =
    source.credential_attribution_source === 'project'
      ? 'project'
      : source.credential_attribution_source === 'platform'
        ? 'platform'
        : 'user';
  const attributionProjectId =
    attributionSource === 'project' ? source.credential_attribution_project_id : null;
  const db = drizzle(env.DATABASE, { schema });
  const { resolveCredentialSource } = await import('./provider-credentials');
  const credential = await resolveCredentialSource(
    db,
    attributionUserId,
    (source.cloud_provider as CredentialProvider | null) ?? undefined,
    attributionProjectId
  );
  if (!credential) {
    log.warn('session_snapshot.relay_provision_skipped_no_credential', {
      userId: input.userId,
      sourceNodeId: input.sourceNodeId,
      provider: source.cloud_provider,
    });
    return;
  }
  if (
    credential.credentialSource === 'platform' &&
    env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false'
  ) {
    const { checkQuotaForUser } = await import('./compute-quotas');
    const quota = await checkQuotaForUser(db, input.userId);
    if (!quota.allowed) {
      log.warn('session_snapshot.relay_provision_skipped_quota', {
        userId: input.userId,
        sourceNodeId: input.sourceNodeId,
      });
      return;
    }
  }

  const { createNodeRecord, provisionNode } = await import('./nodes');
  const created = await createNodeRecord(env, {
    userId: input.userId,
    credentialAttributionUserId: attributionUserId,
    credentialAttributionProjectId: attributionProjectId,
    credentialAttributionSource: attributionSource,
    name,
    vmSize: source.vm_size as 'small' | 'medium' | 'large',
    vmLocation: source.vm_location,
    cloudProvider: (source.cloud_provider as CredentialProvider | null) ?? undefined,
    heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
  });

  log.warn('session_snapshot.relay_provision_started', {
    userId: input.userId,
    sourceNodeId: input.sourceNodeId,
    relayNodeId: created.id,
    requiredVersion,
  });
  await provisionNode(created.id, env);

  const provisioned = await env.DATABASE.prepare(`SELECT status FROM nodes WHERE id = ? LIMIT 1`)
    .bind(created.id)
    .first<{ status: string }>();
  if (provisioned?.status !== 'running') return;

  const lifecycleId = env.NODE_LIFECYCLE.idFromName(created.id);
  const lifecycle = env.NODE_LIFECYCLE.get(lifecycleId) as DurableObjectStub<
    import('../durable-objects/node-lifecycle').NodeLifecycle
  >;
  const project = input.projectId
    ? await env.DATABASE.prepare(
        `SELECT warm_node_timeout_ms FROM projects WHERE id = ? AND user_id = ? LIMIT 1`
      )
        .bind(input.projectId, input.userId)
        .first<{ warm_node_timeout_ms: number | null }>()
    : null;
  await lifecycle.markIdle(created.id, input.userId, project?.warm_node_timeout_ms ?? null);
}
