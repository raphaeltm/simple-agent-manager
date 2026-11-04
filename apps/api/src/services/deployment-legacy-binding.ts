/** Recover legacy deployment binding only from positive provider ownership evidence. */
import { hasAmbiguousLabel } from '@simple-agent-manager/providers';
import { type CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import {
  DEFAULT_NODE_DECISION_DEDUPE_WINDOW_MS,
  recordNodeLifecycleDecision,
} from './node-lifecycle-decisions';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import {
  type ExactProviderCredentialBinding,
  fingerprintEncryptedProviderCredential,
} from './provider-credential-exact';
import { createProviderForUser } from './provider-credentials';

/**
 * Why a legacy binding was not recovered. `not_legacy` means the node is not an unbound managed
 * deployment VM, so recovery does not apply; every other reason names the one piece of ownership
 * evidence that was missing or disagreed, so a stuck teardown can say why (idea
 * 01M6K6R2255R7414WSER4N3STJ: a refusal returned a bare `false` and the node retried for 10 days
 * with nothing recorded).
 */
export type LegacyBindingRefusal =
  | 'not_legacy'
  | 'missing_provider_instance'
  | 'missing_cloud_provider'
  | 'missing_agent_ready'
  | 'missing_credential_attribution'
  | 'attribution_not_owner'
  | 'credential_missing_or_ambiguous'
  | 'credential_unresolvable'
  | 'provider_vm_not_found'
  | 'provider_vm_identity_mismatch'
  | 'installation_identity_unconfigured'
  | 'provider_label_mismatch'
  | 'node_changed_during_recovery';

export type LegacyBindingRecovery =
  { recovered: true } | { recovered: false; reason: LegacyBindingRefusal };

const refuse = (reason: LegacyBindingRefusal): LegacyBindingRecovery => ({
  recovered: false,
  reason,
});

/** Refusals that say nothing about this node's ownership evidence, so are not recorded. */
const UNRECORDED_REFUSALS = new Set<LegacyBindingRefusal>([
  'not_legacy',
  // A providerless node is torn down through provider inventory, never through this binding.
  'missing_provider_instance',
]);

/**
 * Strict deletion and the deployment sweep call this before an unbound legacy deployment VM can be
 * deleted. A refusal is recorded in the node lifecycle decision log (deduplicated, so an hourly
 * retry does not flood it) because strict deletion's own error can only say the binding is missing.
 */
export async function recoverLegacyDeploymentBinding(
  env: Env,
  node: schema.Node,
  signal?: AbortSignal
): Promise<boolean> {
  const result = await attemptLegacyDeploymentBindingRecovery(env, node, signal);
  if (result.recovered) return true;
  if (!UNRECORDED_REFUSALS.has(result.reason)) {
    log.warn('deployment_node.legacy_binding_refused', {
      nodeId: node.id,
      status: node.status,
      reason: result.reason,
    });
    await recordNodeLifecycleDecision(env.DATABASE, {
      nodeId: node.id,
      source: 'cleanup_sweep',
      decision: 'legacy_binding_refused',
      reason: result.reason,
      dedupeWindowMs: DEFAULT_NODE_DECISION_DEDUPE_WINDOW_MS,
    });
  }
  return false;
}

export async function attemptLegacyDeploymentBindingRecovery(
  env: Env,
  node: schema.Node,
  signal?: AbortSignal
): Promise<LegacyBindingRecovery> {
  if (
    node.nodeRole !== 'deployment' ||
    node.nodeClass !== 'managed' ||
    node.runtime !== 'vm' ||
    node.placementCredentialSource ||
    node.placementCredentialReference ||
    node.placementCredentialVersion ||
    node.placementCredentialFingerprint
  )
    return refuse('not_legacy');
  if (!node.providerInstanceId) return refuse('missing_provider_instance');
  if (!node.cloudProvider) return refuse('missing_cloud_provider');
  if (!node.agentReadyAt) return refuse('missing_agent_ready');
  if (!node.credentialAttributionUserId || !node.credentialAttributionSource)
    return refuse('missing_credential_attribution');
  const cloudProvider = node.cloudProvider;
  const providerInstanceId = node.providerInstanceId;
  const agentReadyAt = node.agentReadyAt;
  const db = drizzle(env.DATABASE, { schema });
  const source = node.credentialAttributionSource;
  const attributionUserId = node.credentialAttributionUserId;
  const projectId = source === 'project' ? node.credentialAttributionProjectId : null;
  if (attributionUserId !== node.userId || (source === 'project' && !projectId))
    return refuse('attribution_not_owner');
  const rows =
    source === 'platform'
      ? await db
          .select()
          .from(schema.platformCredentials)
          .where(
            and(
              eq(schema.platformCredentials.credentialType, 'cloud-provider'),
              eq(schema.platformCredentials.provider, node.cloudProvider),
              eq(schema.platformCredentials.isEnabled, true)
            )
          )
          .limit(2)
      : await db
          .select()
          .from(schema.credentials)
          .where(
            and(
              eq(schema.credentials.userId, attributionUserId),
              eq(schema.credentials.credentialType, 'cloud-provider'),
              eq(schema.credentials.provider, node.cloudProvider),
              eq(schema.credentials.isActive, true),
              projectId
                ? eq(schema.credentials.projectId, projectId)
                : isNull(schema.credentials.projectId)
            )
          )
          .limit(2);
  if (!['user', 'project', 'platform'].includes(source)) return refuse('attribution_not_owner');
  const credential = rows.length === 1 ? rows[0] : undefined;
  if (!credential) return refuse('credential_missing_or_ambiguous');
  const fingerprint = await fingerprintEncryptedProviderCredential(
    credential.encryptedToken,
    credential.iv
  );
  const binding: ExactProviderCredentialBinding = {
    credentialSource: source as 'user' | 'project' | 'platform',
    credentialReference: `${source === 'platform' ? 'platform_credentials' : 'credentials'}:${credential.id}`,
    credentialVersion: Date.parse(credential.updatedAt),
    credentialFingerprint: fingerprint,
  };
  const resolved = await createProviderForUser(
    db,
    attributionUserId,
    getCredentialEncryptionKey(env),
    env,
    node.cloudProvider as CredentialProvider,
    projectId,
    binding
  );
  if (!resolved || resolved.providerName !== cloudProvider)
    return refuse('credential_unresolvable');
  const vm = await resolved.provider.getVM(
    node.providerInstanceId,
    signal ? { signal } : undefined
  );
  // A wrong-account 404 is NEVER absence proof and never creates a binding.
  if (!vm) return refuse('provider_vm_not_found');
  if (
    vm.id !== providerInstanceId ||
    vm.location !== node.vmLocation ||
    vm.ip !== node.ipAddress ||
    Date.parse(vm.createdAt) < Date.parse(node.createdAt) ||
    Date.parse(vm.createdAt) > Date.parse(agentReadyAt) ||
    !Number.isFinite(Date.parse(vm.createdAt)) ||
    !Number.isFinite(Date.parse(node.createdAt)) ||
    !Number.isFinite(Date.parse(agentReadyAt))
  )
    return refuse('provider_vm_identity_mismatch');
  const environmentLabel = resolveEnvironmentLabel(env);
  const installationId = resolveInstallationId(env);
  if (!environmentLabel || !installationId) return refuse('installation_identity_unconfigured');
  if (
    hasAmbiguousLabel(vm.labels, 'incarnation') ||
    (!node.runtimeIncarnationId && vm.labels.incarnation !== undefined)
  )
    return refuse('provider_label_mismatch');
  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: true,
    environmentLabel,
    installationId,
    runtimeIncarnationId: node.runtimeIncarnationId ?? undefined,
  });
  for (const [key, value] of Object.entries(labels)) {
    // Old deployments predate installation/incarnation labels. Positive node,
    // role and managed labels plus persisted instance/IP/boot window remain
    // mandatory; any optional label that IS present must match exactly.
    if (
      hasAmbiguousLabel(vm.labels, key) ||
      ((['node', 'role', 'managed'].includes(key) || vm.labels[key] !== undefined) &&
        vm.labels[key] !== value)
    )
      return refuse('provider_label_mismatch');
  }
  const credentialTable = source === 'platform' ? schema.platformCredentials : schema.credentials;
  const credentialFence = and(
    eq(credentialTable.id, credential.id),
    eq(credentialTable.encryptedToken, credential.encryptedToken),
    eq(credentialTable.iv, credential.iv),
    eq(credentialTable.updatedAt, credential.updatedAt)
  );
  const result = await db
    .update(schema.nodes)
    .set({
      placementCredentialSource: binding.credentialSource,
      placementCredentialReference: binding.credentialReference,
      placementCredentialVersion: binding.credentialVersion,
      placementCredentialFingerprint: fingerprint,
    })
    .where(
      and(
        eq(schema.nodes.id, node.id),
        eq(schema.nodes.userId, node.userId),
        eq(schema.nodes.status, node.status),
        sql`${schema.nodes.cloudProvider} IS ${node.cloudProvider}`,
        sql`${schema.nodes.ipAddress} IS ${node.ipAddress}`,
        sql`${schema.nodes.vmLocation} IS ${node.vmLocation}`,
        sql`${schema.nodes.createdAt} IS ${node.createdAt}`,
        sql`${schema.nodes.agentReadyAt} IS ${node.agentReadyAt}`,
        sql`EXISTS (SELECT 1 FROM ${credentialTable} WHERE ${credentialFence})`,
        eq(schema.nodes.nodeRole, 'deployment'),
        eq(schema.nodes.nodeClass, 'managed'),
        eq(schema.nodes.runtime, 'vm'),
        eq(schema.nodes.providerInstanceId, node.providerInstanceId),
        sql`${schema.nodes.runtimeIncarnationId} IS ${node.runtimeIncarnationId}`,
        sql`${schema.nodes.credentialAttributionUserId} IS ${node.credentialAttributionUserId}`,
        sql`${schema.nodes.credentialAttributionProjectId} IS ${node.credentialAttributionProjectId}`,
        sql`${schema.nodes.credentialAttributionSource} IS ${node.credentialAttributionSource}`,
        isNull(schema.nodes.placementCredentialSource),
        isNull(schema.nodes.placementCredentialReference),
        isNull(schema.nodes.placementCredentialVersion),
        isNull(schema.nodes.placementCredentialFingerprint)
      )
    )
    .run();
  return result.meta.changes === 1 ? { recovered: true } : refuse('node_changed_during_recovery');
}
