/**
 * Which credential may tear down a managed VM, and how the VM is proven to be the node's.
 *
 * Teardown authority does not depend on the credential that created the node. The pinned
 * placement credential is used while it still resolves to its exact generation. When it does not
 * (the row was deleted and re-inserted by a re-save or reconnect, or its ciphertext was rotated),
 * the node owner's CURRENT credentials for the node's provider are used instead, and ownership is
 * proven from the instance itself: immediately before the provider delete, the instance is re-read
 * and must carry the recorded provider instance ID and every exact SAM ownership label (managed,
 * node, role, environment, installation, runtime incarnation). This is the destructive ownership
 * proof `packages/providers/.claude/rules/56` requires. A VM that does not prove ownership is
 * preserved, and a credential that cannot see the VM never counts as proof it is gone.
 *
 * Every refusal on the current-credential path is a {@link NodeTeardownBlockedError} naming its
 * own condition, so the node can surface it instead of retrying silently (rules 71, 74).
 */
import { ProviderError, type ProviderRequestContext } from '@simple-agent-manager/providers';
import { timestampVersion } from '@simple-agent-manager/scheduler-core';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, asc, eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  buildNodeProviderLabels,
  nodeProviderLabelsMatch,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import {
  fingerprintEncryptedProviderCredential,
  hasExactProviderCredentialGenerationProof,
} from './provider-credential-exact';
import { createProviderForUser } from './provider-credentials';
import {
  getStrictNodeCredentialContext,
  type NodeDb,
  type NodeRow,
  type ProviderForUserResult,
} from './strict-node-deletion-shared';

/** Prefix shared by every named teardown refusal stored in `nodes.cleanup_blocked_reason`. */
export const NODE_TEARDOWN_BLOCKED_REASON_PREFIX = 'teardown_';

export const NODE_TEARDOWN_BLOCKED_REASONS = [
  /** Neither the placement credential nor any current credential of the owner resolves. */
  'teardown_credential_unavailable',
  /** No current owner credential can see the instance: removed, or pointing at another account. */
  'teardown_instance_not_visible',
  /** A credential sees the instance, but its ID or ownership labels are not this node's. */
  'teardown_instance_ownership_mismatch',
  /** This installation or node record lacks the identity needed to prove ownership at all. */
  'teardown_ownership_scope_unavailable',
] as const;

export type NodeTeardownBlockedReason = (typeof NODE_TEARDOWN_BLOCKED_REASONS)[number];

export class NodeTeardownBlockedError extends Error {
  constructor(
    readonly reason: NodeTeardownBlockedReason,
    detail: string
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'NodeTeardownBlockedError';
  }
}

export type StrictNodeTeardownAuthority =
  | { kind: 'pinned'; providerResult: ProviderForUserResult }
  | { kind: 'current_owner_credential'; candidates: ProviderForUserResult[] };

async function resolvePinnedCredential(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<ProviderForUserResult | null> {
  const { targetProvider, attributionUserId, attributionProjectId, exactCredential } =
    getStrictNodeCredentialContext(node, userId);
  if (!targetProvider || !hasExactProviderCredentialGenerationProof(exactCredential)) return null;
  try {
    return await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId,
      exactCredential
    );
  } catch (error) {
    // A malformed or undecryptable stored credential is data, not a server fault (rule 41).
    log.warn('node_teardown.pinned_credential_unreadable', {
      nodeId: node.id,
      provider: targetProvider,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The node owner's current credentials for the node's provider, in provisioning order. Scope is
 * the node's own credential attribution (user, plus project when the node was project-attributed),
 * resolved by `createProviderForUser` exactly as provisioning resolves it (project, then user,
 * then platform), followed by every enabled platform credential for the provider, so a node placed
 * on the platform credential stays reachable when its owner has since added their own. Never
 * another user's or another project's credential: no lookup here is keyed by provider name alone.
 *
 * Deliberate difference from rule 28's "an inactive scoped credential blocks fallback": that rule
 * stops a deactivated credential from being silently replaced for NEW work. Here the platform rows
 * are tried even when the owner's project resolution halts, because teardown only ever deletes an
 * instance that proves, by its own labels, that it is this node's VM (`proveNodeInstanceOwnership`).
 *
 * `failed` is true when any resolution threw (a transient D1 or decryption fault, or a malformed
 * row). An empty result after a failure is not proof the owner has no credential.
 */
async function resolveCurrentOwnerCredentials(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  targetProvider: CredentialProvider
): Promise<{ candidates: ProviderForUserResult[]; failed: boolean }> {
  const { attributionUserId, attributionProjectId } = getStrictNodeCredentialContext(node, userId);
  const encryptionKey = getCredentialEncryptionKey(env);
  const candidates: ProviderForUserResult[] = [];
  const seen = new Set<string>();
  let failed = false;
  const add = (result: ProviderForUserResult | null) => {
    if (!result || result.providerName !== targetProvider) return;
    const key =
      result.exactCredentialBinding?.credentialReference ?? `source:${result.credentialSource}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(result);
  };
  const isolate = async (tier: string, resolve: () => Promise<ProviderForUserResult | null>) => {
    try {
      add(await resolve());
    } catch (error) {
      // One unreadable credential must not hide the next one (rule 41).
      failed = true;
      log.warn('node_teardown.current_credential_unreadable', {
        nodeId: node.id,
        provider: targetProvider,
        tier,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await isolate('provisioning_order', () =>
    createProviderForUser(
      db,
      attributionUserId,
      encryptionKey,
      env,
      targetProvider,
      attributionProjectId
    )
  );
  let platformRows: Array<typeof schema.platformCredentials.$inferSelect> = [];
  try {
    platformRows = await db
      .select()
      .from(schema.platformCredentials)
      .where(
        and(
          eq(schema.platformCredentials.credentialType, 'cloud-provider'),
          eq(schema.platformCredentials.provider, targetProvider),
          eq(schema.platformCredentials.isEnabled, true)
        )
      )
      .orderBy(asc(schema.platformCredentials.id));
  } catch (error) {
    failed = true;
    log.warn('node_teardown.platform_credentials_unreadable', {
      nodeId: node.id,
      provider: targetProvider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const row of platformRows) {
    // The exact path decrypts and re-checks this generation; nothing is decrypted twice.
    await isolate(`platform:${row.id}`, async () =>
      createProviderForUser(
        db,
        attributionUserId,
        encryptionKey,
        env,
        targetProvider,
        attributionProjectId,
        {
          credentialSource: 'platform',
          credentialReference: `platform_credentials:${row.id}`,
          credentialVersion: timestampVersion(row.updatedAt ?? row.createdAt),
          credentialFingerprint: await fingerprintEncryptedProviderCredential(
            row.encryptedToken,
            row.iv
          ),
        }
      )
    );
  }
  return { candidates, failed };
}

/**
 * Decide which credential tears this node down. The pinned placement credential wins whenever it
 * still resolves to its exact generation; otherwise the owner's current credentials are returned
 * and the caller MUST prove ownership with {@link proveNodeInstanceOwnership} before deleting.
 */
export async function resolveStrictNodeTeardownAuthority(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env
): Promise<StrictNodeTeardownAuthority> {
  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  if (!targetProvider) {
    throw new Error(`Cannot strictly delete node ${node.id}: cloudProvider is missing`);
  }
  const pinned = await resolvePinnedCredential(db, node, userId, env);
  if (pinned) {
    if (pinned.providerName !== targetProvider) {
      throw new Error(
        `Cannot strictly delete node ${node.id}: persisted provider binding did not resolve exactly`
      );
    }
    return { kind: 'pinned', providerResult: pinned };
  }

  const { candidates, failed } = await resolveCurrentOwnerCredentials(
    db,
    node,
    userId,
    env,
    targetProvider
  );
  log.warn('node_teardown.pinned_credential_unresolved', {
    nodeId: node.id,
    provider: targetProvider,
    placementCredentialSource: node.placementCredentialSource,
    currentCredentialSources: candidates.map((candidate) => candidate.credentialSource),
    resolutionFailed: failed,
  });
  if (candidates.length === 0 && failed) {
    // Inconclusive: an ordinary failure, retried on the normal backoff, never a blocked verdict.
    throw new Error(
      `Cannot strictly delete node ${node.id}: current credential resolution failed; will retry`
    );
  }
  if (candidates.length === 0) {
    throw new NodeTeardownBlockedError(
      'teardown_credential_unavailable',
      `node=${node.id} provider=${targetProvider}: neither the placement credential nor any ` +
        'current credential of the node owner resolves'
    );
  }
  return { kind: 'current_owner_credential', candidates };
}

/** The exact labels SAM stamped on this node's VM at creation (`provisionNode`). */
function expectedNodeOwnershipLabels(node: NodeRow, env: Env): Record<string, string> {
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel) {
    throw new NodeTeardownBlockedError(
      'teardown_ownership_scope_unavailable',
      `node=${node.id}: this installation has no valid SAM_INSTALLATION_ID or ENVIRONMENT, so ` +
        'instance ownership cannot be proven'
    );
  }
  const runtimeIncarnationId = node.runtimeIncarnationId?.trim();
  if (!runtimeIncarnationId) {
    throw new NodeTeardownBlockedError(
      'teardown_ownership_scope_unavailable',
      `node=${node.id}: the node has no runtime incarnation, so instance ownership cannot be proven`
    );
  }
  return buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: node.nodeRole === 'deployment',
    environmentLabel,
    installationId,
    runtimeIncarnationId,
  });
}

/**
 * Re-read the node's instance through each current owner credential and return the one that
 * proves ownership: same provider instance ID, and every exact SAM ownership label. Call this
 * immediately before `deleteVM`.
 *
 * - An instance that is visible but not provably this node's is never deleted. The search moves on
 *   to the next credential, since an account-scoped ID can collide; if no credential proves
 *   ownership, the mismatch is the verdict.
 * - Not found through every credential is NOT absence proof: a wrong-account 404 looks the same as
 *   a deleted VM.
 * - A failed read is inconclusive; it is rethrown as an ordinary error so the next retry decides.
 */
export async function proveNodeInstanceOwnership(
  node: NodeRow,
  env: Env,
  candidates: readonly ProviderForUserResult[],
  requestContext?: ProviderRequestContext
): Promise<ProviderForUserResult> {
  const instanceId = node.providerInstanceId;
  if (!instanceId) {
    throw new Error(`Cannot prove instance ownership for node ${node.id}: instance ID is missing`);
  }
  const labels = expectedNodeOwnershipLabels(node, env);
  let readFailure: unknown;
  let mismatch: NodeTeardownBlockedError | undefined;
  for (const candidate of candidates) {
    let instance;
    try {
      instance = requestContext
        ? await candidate.provider.getVM(instanceId, requestContext)
        : await candidate.provider.getVM(instanceId);
    } catch (error) {
      if (requestContext?.signal?.aborted) throw error;
      if (isCredentialRejection(error)) {
        // A revoked or wrong-scope credential can never answer for this instance: it cannot
        // see it, which is a verdict, not a transient read failure to retry silently.
        log.warn('node_teardown.ownership_read_rejected', {
          nodeId: node.id,
          credentialSource: candidate.credentialSource,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      readFailure = error;
      log.warn('node_teardown.ownership_read_failed', {
        nodeId: node.id,
        credentialSource: candidate.credentialSource,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (!instance) continue;
    if (instance.id !== instanceId || !nodeProviderLabelsMatch(instance.labels, labels)) {
      // Not this node's VM through this account. Another candidate (e.g. the platform account
      // that actually placed it) may still prove ownership; the foreign instance is never deleted.
      mismatch = new NodeTeardownBlockedError(
        'teardown_instance_ownership_mismatch',
        `node=${node.id} instance=${instanceId}: the instance visible to the owner's current ` +
          `${candidate.credentialSource ?? 'cloud'} credential does not carry this node's exact ` +
          'SAM ownership labels; it was preserved'
      );
      continue;
    }
    return candidate;
  }
  if (readFailure !== undefined) throw readFailure;
  if (mismatch) throw mismatch;
  throw new NodeTeardownBlockedError(
    'teardown_instance_not_visible',
    `node=${node.id} instance=${instanceId}: no current credential of the node owner can see ` +
      'the instance; it may still exist under a removed or different cloud account'
  );
}

/**
 * The provider refused this credential (401/403 or a categorised auth error), so it can never
 * answer for the instance. Rate limits, capacity and server errors are temporary and excluded
 * (rule 72). Same classification as `node-manual-deletion.ts`.
 */
function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.statusCode === 401 || error.statusCode === 403 || error.category === 'auth_error';
}
