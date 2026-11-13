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
import type { ProviderRequestContext } from '@simple-agent-manager/providers';
import type { CredentialProvider } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  buildNodeProviderLabels,
  nodeProviderLabelsMatch,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { getPlatformCloudCredential } from './platform-credentials';
import { hasExactProviderCredentialGenerationProof } from './provider-credential-exact';
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
 * then platform), followed by the installation's current platform credential so a node placed on
 * the platform credential stays reachable when its owner has since added their own. Never another
 * user's or another project's credential: no lookup here is keyed by provider name alone.
 */
async function resolveCurrentOwnerCredentials(
  db: NodeDb,
  node: NodeRow,
  userId: string,
  env: Env,
  targetProvider: CredentialProvider
): Promise<ProviderForUserResult[]> {
  const { attributionUserId, attributionProjectId } = getStrictNodeCredentialContext(node, userId);
  const encryptionKey = getCredentialEncryptionKey(env);
  const candidates: ProviderForUserResult[] = [];
  const seen = new Set<string>();
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
      // One unreadable credential must not hide the next tier (rule 41).
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
  await isolate('platform', async () => {
    const platform = await getPlatformCloudCredential(db, encryptionKey, targetProvider);
    if (!platform?.credentialId) return null;
    return createProviderForUser(
      db,
      attributionUserId,
      encryptionKey,
      env,
      targetProvider,
      attributionProjectId,
      {
        credentialSource: 'platform',
        credentialReference: `platform_credentials:${platform.credentialId}`,
        credentialVersion: platform.credentialVersion,
        credentialFingerprint: platform.credentialFingerprint,
      }
    );
  });
  return candidates;
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

  const candidates = await resolveCurrentOwnerCredentials(db, node, userId, env, targetProvider);
  log.warn('node_teardown.pinned_credential_unresolved', {
    nodeId: node.id,
    provider: targetProvider,
    placementCredentialSource: node.placementCredentialSource,
    currentCredentialSources: candidates.map((candidate) => candidate.credentialSource),
  });
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
 * - An instance that is visible but not provably this node's is preserved: the first such answer
 *   stops the search, because no other credential can make a foreign VM ours.
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
  for (const candidate of candidates) {
    let instance;
    try {
      instance = requestContext
        ? await candidate.provider.getVM(instanceId, requestContext)
        : await candidate.provider.getVM(instanceId);
    } catch (error) {
      if (requestContext?.signal?.aborted) throw error;
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
      throw new NodeTeardownBlockedError(
        'teardown_instance_ownership_mismatch',
        `node=${node.id} instance=${instanceId}: the instance visible to the current ` +
          `${candidate.credentialSource} credential does not carry this node's exact SAM ` +
          'ownership labels; it was preserved'
      );
    }
    return candidate;
  }
  if (readFailure !== undefined) throw readFailure;
  throw new NodeTeardownBlockedError(
    'teardown_instance_not_visible',
    `node=${node.id} instance=${instanceId}: no current credential of the node owner can see ` +
      'the instance; it may still exist under a removed or different cloud account'
  );
}
