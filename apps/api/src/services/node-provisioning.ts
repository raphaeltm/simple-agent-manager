import { validateCloudInitSize } from '@simple-agent-manager/cloud-init';
import {
  isProviderCreateNotDispatched,
  type ProviderRequestContext,
  throwIfProviderRequestAborted,
} from '@simple-agent-manager/providers';
import { type CredentialProvider, type TaskMode } from '@simple-agent-manager/shared';
import { type and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { createNodeBackendDNSRecord } from './dns';
import { signCurrentNodeCallbackToken } from './jwt';
import {
  durableAllocationMayHaveCreated,
  type DurableNodeAllocation,
  NodeAllocationUncertainError,
  recoverNodeAllocation,
  summarizeProvisioningFailure,
} from './node-allocation-recovery';
import {
  assertNodeAllocationPlanCurrent,
  type NodeAllocationPlanRole,
} from './node-allocation-validation';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';
import { buildNodeCloudInit } from './node-provisioning-cloud-init';
import { handleNodeProvisioningFailure } from './node-provisioning-failure';
import { resolveHetznerBaseImageOverride } from './node-provisioning-image';
import {
  creatingProvisioningPredicate,
  d1WriteChanged,
  isProviderCreateRejectedBeforeVmIdentity,
  providerIdentityRecordPredicate,
  truncateNodeErrorMessage,
} from './node-provisioning-predicates';
import {
  cleanupCreatedVmAfterProvisioningRace,
  deleteCreatedProviderVmDirectly,
} from './node-provisioning-race-cleanup';
export { resolveHetznerBaseImageOverride } from './node-provisioning-image';
import { prepareNodeTunnelIngress } from './node-provisioning-ingress';
import { recordRejectedAllocationAbsence } from './node-rejection-proof';
import { nodeTransportExtension } from './node-transport-extension';
import { resolveManagedNodeTransport, type TunnelEnv } from './node-tunnel-config';
import type { NodeTunnelProvisioningPhase } from './node-tunnel-provisioning';
import {
  createProviderForUser,
  type ExactProviderCredentialBinding,
  exactProviderCredentialBindingFromPlacementSnapshot,
} from './provider-credentials';
import {
  applyNativePlanToVmConfig,
  assertNativePlanConcrete,
  observedHardwareDbValues,
} from './runtime-allocation';
import { deleteNodeResourcesStrict } from './strict-node-deletion';

/** Optional task context for cloud-init (enables message reporter on VM). */
export interface ProvisionTaskContext {
  projectId: string;
  chatSessionId: string;
  taskId: string;
  taskMode?: TaskMode;
}

/** Deployment node context for cloud-init (sets role=deployment + environmentId). */
export interface DeploymentProvisionContext {
  environmentId: string;
  projectId?: string | null;
}

export interface ProvisionNodeOptions {
  /**
   * When true, re-throw provider failures (preserving `ProviderError.category` and
   * `providerCode`) instead of silently writing a `status:'error'` node row and
   * returning. The TaskRunner size-fallback descent loop sets this so it can branch
   * on the error category (capacity → descend; anything else → fail fast).
   *
   * On a `transient_capacity` failure this also DELETES the failed node row before
   * throwing, so failed size attempts leave no orphaned `error` rows. Non-capacity
   * failures keep the existing `status:'error'` row before re-throwing.
   *
   * Legacy callers omit this and retain the original swallow-and-record behavior.
   */
  rethrowProviderError?: boolean;
  /** Persist caller recovery intent before removing a proven pre-identity rejection. */
  beforeRejectedNodeDelete?: () => Promise<void>;
  /** Durable direct allocation owner: retries reconcile this nonce, never repeat an uncertain POST. */
  durableAllocation?: DurableNodeAllocation;
  /** Explicit lifecycle cancellation for provider work; detached HTTP callers omit this. */
  signal?: AbortSignal;
  /** Fail-closed recovery-authority check at the provider allocation boundary. */
  assertExternalMutationAuthority?: () => Promise<void>;
  /** Project context used for placement-authority checks when no taskContext exists. */
  authorityProjectId?: string | null;
}

function provisionAuthorityProjectId(
  taskContext: ProvisionTaskContext | undefined,
  options: ProvisionNodeOptions | undefined,
  deploymentContext: DeploymentProvisionContext | undefined
): string | null {
  return (
    taskContext?.projectId ?? options?.authorityProjectId ?? deploymentContext?.projectId ?? null
  );
}

export async function provisionNode(
  nodeId: string,
  env: Env,
  taskContext?: ProvisionTaskContext,
  options?: ProvisionNodeOptions,
  deploymentContext?: DeploymentProvisionContext
): Promise<{ allocationConfirmed: true } | void> {
  const providerContext: ProviderRequestContext | undefined = options?.signal
    ? { signal: options.signal }
    : undefined;
  throwIfProviderRequestAborted(providerContext);
  const db = drizzle(env.DATABASE, { schema });
  const tunnelEnv: TunnelEnv = env;

  const nodes = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);

  const node = nodes[0];
  if (!node) {
    return;
  }

  const targetProvider = (node.cloudProvider as CredentialProvider | null) ?? undefined;
  let attemptedProvider = targetProvider;
  let resolvedCredentialBinding: ExactProviderCredentialBinding | undefined;
  let provisioningRuntimeIncarnationId = node.runtimeIncarnationId;
  let providerCreateRejected = false;
  let providerAllocationRejected = false;
  let rejectedPlacementPredicate: ReturnType<typeof and>;
  let providerRejectionProofAt: string | null = null;
  // Tunnel bookkeeping for the failure path: was ownership journaled, and could a VM exist?
  let tunnelJournaled = false;
  let tunnelPhase: NodeTunnelProvisioningPhase | null = null;
  let providerCreateRequested = false;
  const attributionUserId = node.credentialAttributionUserId ?? node.userId;
  const attributionProjectId =
    node.credentialAttributionSource === 'project'
      ? (node.credentialAttributionProjectId ?? taskContext?.projectId ?? null)
      : null;
  const exactCredential = exactProviderCredentialBindingFromPlacementSnapshot(node);
  const authorityProjectId = provisionAuthorityProjectId(taskContext, options, deploymentContext);
  // Caller intent, not the node row: a deployment provision supplies a deployment
  // context, everything else is placing a workspace node.
  const authorityRole: NodeAllocationPlanRole = deploymentContext
    ? { nodeRole: 'deployment', workloadRole: 'deployment' }
    : { nodeRole: 'workspace', workloadRole: 'workspace' };

  const durable = options?.durableAllocation;
  const resuming =
    !!durable &&
    node.runtimeIncarnationId === durable.incarnationId &&
    node.runtimeTerminationConfirmedAt === null;
  // A resumed attempt reconciles the exact inventory only when an earlier attempt may have
  // sent the create; one cut before its create POST (e.g. inside tunnel setup) creates instead.
  const recoverExisting = resuming && !!durable && durableAllocationMayHaveCreated(durable);
  if (
    durable &&
    !resuming &&
    (node.runtimeIncarnationId !== durable.initialIncarnationId ||
      node.runtimeTerminationConfirmedAt === null)
  ) {
    throw new NodeAllocationUncertainError('Node incarnation changed before durable allocation');
  }

  try {
    // A resumed allocation keeps the transport its (possibly already created) VM was
    // booted with; only a new incarnation reads the installation's current choice.
    let transport = node.transport === 'vm-public-dns' ? null : node.transport;
    if (!resuming) {
      transport = resolveManagedNodeTransport(tunnelEnv, {
        runtime: node.runtime,
        nodeClass: node.nodeClass,
        nodeRole: node.nodeRole,
      });
    }
    if (!resuming)
      await assertNodeAllocationPlanCurrent(
        env,
        node.id,
        node.userId,
        authorityProjectId,
        authorityRole
      );
    const providerResult = await createProviderForUser(
      db,
      attributionUserId,
      getCredentialEncryptionKey(env),
      env,
      targetProvider,
      attributionProjectId,
      exactCredential
    );
    if (!providerResult) {
      throw new Error(
        targetProvider
          ? `Cloud provider "${targetProvider}" not connected`
          : 'Cloud provider account not connected'
      );
    }
    throwIfProviderRequestAborted(providerContext);
    attemptedProvider = providerResult.providerName;
    resolvedCredentialBinding = providerResult.exactCredentialBinding;
    assertNativePlanConcrete(providerResult.providerName, node);

    // Persist the resolved provider identity before external provisioning so
    // cleanup never has to guess which third-party API owns the VM.
    provisioningRuntimeIncarnationId = durable?.incarnationId ?? crypto.randomUUID();
    if (!resuming) {
      const providerIdentityClaim = await db
        .update(schema.nodes)
        .set({
          cloudProvider: providerResult.providerName,
          credentialSource: providerResult.credentialSource,
          credentialAttributionUserId: attributionUserId,
          credentialAttributionProjectId:
            providerResult.credentialSource === 'project' ? attributionProjectId : null,
          credentialAttributionSource: providerResult.credentialSource,
          placementCredentialSource:
            providerResult.exactCredentialBinding?.credentialSource ??
            node.placementCredentialSource,
          placementCredentialReference:
            providerResult.exactCredentialBinding?.credentialReference ??
            node.placementCredentialReference,
          placementCredentialVersion:
            providerResult.exactCredentialBinding?.credentialVersion ??
            node.placementCredentialVersion,
          placementCredentialFingerprint:
            providerResult.exactCredentialBinding?.credentialFingerprint ??
            node.placementCredentialFingerprint,
          runtimeIncarnationId: provisioningRuntimeIncarnationId,
          transport: transport ?? 'vm-public-dns',
          tunnelId: null,
          tunnelName: null,
          cleanupRetirementSourcesJson: null,
          runtimeTerminationConfirmedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(creatingProvisioningPredicate(node, node.runtimeIncarnationId))
        .run();
      if (!d1WriteChanged(providerIdentityClaim)) {
        throw new Error('Node lifecycle changed before provider allocation could be claimed');
      }
    }

    const callbackToken = await signCurrentNodeCallbackToken(node.id, env);

    const isDeploymentNode = !!deploymentContext;

    const ingress = await prepareNodeTunnelIngress(env, transport, {
      nodeId: node.id, userId: node.userId,
      runtimeIncarnationId: provisioningRuntimeIncarnationId,
      signal: options?.signal,
      onOwnershipRecorded: () => { tunnelJournaled = true; },
      onPhase: (phase) => { tunnelPhase = phase; },
    });
    const { tunnel } = ingress;
    const tunnelIngress = !!tunnel || !!ingress.renderCloudInit;
    tunnelPhase = null;

    const cloudInit = buildNodeCloudInit({
      env,
      node,
      runtimeIncarnationId: provisioningRuntimeIncarnationId,
      callbackToken,
      providerName: providerResult.providerName,
      taskContext,
      deploymentContext,
      tunnel,
      renderCloudInit: ingress.renderCloudInit,
    });

    if (!validateCloudInitSize(cloudInit)) {
      throw new Error('Cloud-init config exceeds size limit');
    }

    const provider = providerResult.provider;

    const baseImageOverride = resolveHetznerBaseImageOverride(
      providerResult.providerName,
      env.HETZNER_BASE_IMAGE
    );

    // Last authority check before the paid provider allocation. A revocation
    // that races createVM is handled by the post-request check below, which can
    // strictly destroy the resource using the persisted provider identity.
    if (!recoverExisting) {
      await assertNodeAllocationPlanCurrent(
        env,
        node.id,
        node.userId,
        authorityProjectId,
        authorityRole
      );
      await options?.assertExternalMutationAuthority?.();
    }
    const vmConfig = applyNativePlanToVmConfig(
      {
        name: `node-${node.id.toLowerCase()}`,
        size: node.vmSize as 'small' | 'medium' | 'large',
        location: node.vmLocation,
        instanceType: node.providerInstanceType ?? undefined,
        userData: cloudInit,
        ...(baseImageOverride ? { image: baseImageOverride } : {}),
        labels: buildNodeProviderLabels({
          nodeId: node.id,
          isDeploymentNode,
          environmentLabel: resolveEnvironmentLabel(env),
          installationId: resolveInstallationId(env),
          runtimeIncarnationId: provisioningRuntimeIncarnationId ?? undefined,
          // Only the box's reverse tunnel carries app ingress; Cloudflare installs no extension.
          appIngressThroughTransport: !!nodeTransportExtension(transport)?.appRouteAddress,
        }),
      },
      node
    );
    let vm: Awaited<ReturnType<typeof provider.createVM>>;
    // A durable attempt counts as having requested a create only once its mark is recorded, so
    // a failure before the mark is attributed to `before_provider`, not `provider_create`.
    if (!durable?.markProviderCreateRequested || recoverExisting) providerCreateRequested = true;
    try {
      if (!recoverExisting && durable?.markProviderCreateRequested) {
        // The last cancellation point before the create. Not after the mark: a cut there would
        // leave a recorded create that was never sent, which every later attempt can only fail
        // to reconcile. After the mark the create is not cancelled by the deadline (below).
        throwIfProviderRequestAborted(providerContext);
        await durable.markProviderCreateRequested();
        providerCreateRequested = true;
      }
      // A durable create or recovery runs to completion once started: the attempt deadline
      // must not cut it. Staging, GCP: a cut between the mark and the POST (inside the OAuth
      // token exchange) left a recorded create with nothing to reconcile, and a cut inside the
      // read-only recovery (aggregated list + getVM) repeated on every attempt. Both are
      // bounded by the provider's own request (30 s) and operation-poll timeouts.
      const createContext = durable ? undefined : providerContext;
      vm = await (recoverExisting && durable
        ? recoverNodeAllocation(provider, node, env, durable, createContext)
        : createContext
          ? provider.createVM(vmConfig, createContext)
          : provider.createVM(vmConfig));
    } catch (err) {
      if (err instanceof NodeAllocationUncertainError) throw err;
      // Hetzner's placement/capacity retries only repeat rejected creates. A
      // transport failure has no HTTP status and cannot prove absence. Keep
      // this at the create boundary: later failures and multi-step providers
      // can occur after allocation even when no VM identity reached the caller.
      providerCreateRejected = isProviderCreateRejectedBeforeVmIdentity(
        providerResult.providerName,
        err
      );
      if (providerCreateRejected) {
        const proof = await recordRejectedAllocationAbsence(
          db,
          node,
          providerResult,
          provisioningRuntimeIncarnationId
        );
        providerAllocationRejected = !!proof;
        providerRejectionProofAt = proof?.proofAt ?? null;
        rejectedPlacementPredicate = proof?.placementPredicate;
      }
      if (
        durable &&
        !recoverExisting &&
        durable.clearProviderCreateRequested &&
        isProviderCreateNotDispatched(err)
      ) {
        // The provider proved its create request was never sent (GCP: token exchange or
        // firewall ensure failed). Withdraw the record so the next attempt creates again
        // (bounded by the intent's attempt and age limits), and keep the real error as the cause.
        await durable.clearProviderCreateRequested();
        providerCreateRequested = false;
        throw new NodeAllocationUncertainError(
          `Provider create was not sent; the next attempt retries it (${summarizeProvisioningFailure(err)})`,
          { cause: err }
        );
      }
      if (durable && !providerAllocationRejected) {
        throw new NodeAllocationUncertainError(
          `Provider allocation is unresolved; exact resource reconciliation is required (${summarizeProvisioningFailure(err)})`,
          { cause: err }
        );
      }
      throw err;
    }
    // From here on a durable attempt publishes what it created or adopted regardless of the
    // attempt deadline: D1 writes and authority re-checks, each bounded by its own timeout
    // (the public-IP DNS call below keeps the deadline). Cutting it here only made every later attempt repeat the
    // same publish (staging, GCP, 2026-11-11). Non-durable callers keep their cancellation.
    const publishContext = durable ? undefined : providerContext;
    throwIfProviderRequestAborted(publishContext);

    // Persist the provider identity before the post-request authority check so
    // a revocation that races createVM can strictly destroy the paid resource.
    const providerIdentityRecord = await db
      .update(schema.nodes)
      .set({
        providerInstanceId: vm.id,
        ...(durable
          ? {
              status: sql`CASE WHEN ${schema.nodes.status} IN ('creating','running','recovery','error') THEN 'creating' ELSE ${schema.nodes.status} END`,
              cleanupBlockedSince: sql`CASE WHEN ${schema.nodes.status} IN ('stopped','destroying') THEN ${schema.nodes.cleanupBlockedSince} ELSE NULL END`,
              cleanupBlockedReason: sql`CASE WHEN ${schema.nodes.status} IN ('stopped','destroying') THEN ${schema.nodes.cleanupBlockedReason} ELSE NULL END`,
            }
          : {}),
        ...observedHardwareDbValues(vm),
        ipAddress: vm.ip || null,
        runtimeTerminationConfirmedAt: null,
        updatedAt: new Date().toISOString(),
      })
      .where(providerIdentityRecordPredicate(node, provisioningRuntimeIncarnationId))
      .run();
    if (!d1WriteChanged(providerIdentityRecord)) {
      await cleanupCreatedVmAfterProvisioningRace({
        node,
        env,
        provider,
        providerInstanceId: vm.id,
        runtimeIncarnationId: provisioningRuntimeIncarnationId,
        providerContext: publishContext,
      });
      throw new Error('Node lifecycle changed before provider identity could be recorded');
    }
    try {
      if (['destroying', 'deleted', 'stopped'].includes(node.status))
        throw new Error('Node allocation was cancelled');
      await assertNodeAllocationPlanCurrent(
        env,
        node.id,
        node.userId,
        authorityProjectId,
        authorityRole
      );
      await options?.assertExternalMutationAuthority?.();
    } catch (authorityErr) {
      log.error('node_provisioning.authority_revoked_after_create', {
        nodeId: node.id,
        providerInstanceId: vm.id,
        ...serializeError(authorityErr),
      });
      try {
        await deleteNodeResourcesStrict(node.id, node.userId, env, {
          cleanupDns: false,
          providerRequestContext: publishContext,
          expectedRuntime: {
            userId: node.userId,
            runtime: node.runtime,
            providerInstanceId: vm.id,
            runtimeIncarnationId: provisioningRuntimeIncarnationId,
          },
        });
      } catch (cleanupErr) {
        log.error('node_provisioning.authority_revoked_cleanup_failed', {
          nodeId: node.id,
          providerInstanceId: vm.id,
          ...serializeError(cleanupErr),
        });
        await deleteCreatedProviderVmDirectly({
          env,
          runtimeIncarnationId: provisioningRuntimeIncarnationId,
          provider,
          providerInstanceId: vm.id,
          nodeId: node.id,
          providerContext: publishContext,
        });
      }
      throw authorityErr;
    }

    // Scaleway allocates IPs asynchronously after boot — vm.ip will be empty.
    // Store the provider instance ID and mark as pending-ip; heartbeat backfill
    // will capture the IP when the VM agent sends its first heartbeat.
    // Tunnel nodes are reached through cloudflared, never the public IP: no IP wait and no
    // A record (the heartbeat never creates one for them, keyed on nodes.tunnel_id). A
    // deployment tunnel node still serves its app routes on the public IP, so it waits for
    // one; its heartbeat records that IP without an A record (routes/node-lifecycle.ts).
    if (!vm.ip && (!tunnelIngress || isDeploymentNode)) {
      log.info('node_provisioning.awaiting_ip_backfill', {
        nodeId: node.id,
        providerInstanceId: vm.id,
      });
      const awaitingIpUpdate = await db
        .update(schema.nodes)
        .set({
          cloudProvider: providerResult.providerName,
          credentialSource: providerResult.credentialSource,
          credentialAttributionUserId: attributionUserId,
          credentialAttributionProjectId:
            providerResult.credentialSource === 'project' ? attributionProjectId : null,
          credentialAttributionSource: providerResult.credentialSource,
          providerInstanceId: vm.id,
          ...observedHardwareDbValues(vm),
          runtimeTerminationConfirmedAt: null,
          status: 'creating',
          errorMessage: 'Awaiting IP allocation — will be set on first heartbeat',
          updatedAt: new Date().toISOString(),
          cleanupBlockedSince: null,
          cleanupBlockedReason: null,
          cleanupBlockedAlertedAt: null,
        })
        .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId, vm.id))
        .run();
      if (!d1WriteChanged(awaitingIpUpdate)) {
        await cleanupCreatedVmAfterProvisioningRace({
          node,
          env,
          provider,
          providerInstanceId: vm.id,
          runtimeIncarnationId: provisioningRuntimeIncarnationId,
          providerContext: publishContext,
        });
        throw new Error('Node lifecycle changed before pending-IP state could be published');
      }
      throwIfProviderRequestAborted(publishContext);
      return { allocationConfirmed: true };
    }

    let backendDnsRecordId: string | null = null;
    let dnsErrorMessage: string | null = null;
    if (!tunnelIngress) {
      try {
        backendDnsRecordId = durable
          ? await createNodeBackendDNSRecord(node.id, vm.ip, env, providerContext?.signal, true)
          : await createNodeBackendDNSRecord(node.id, vm.ip, env);
      } catch (dnsErr) {
        // The DNS create stays on the attempt's deadline: a lost response is cut and adopted
        // exactly on replay (createNodeBackendDNSRecord recoverExisting). Tunnel nodes skip it.
        throwIfProviderRequestAborted(providerContext);
        log.error('node_provisioning.dns_record_failed', {
          nodeId: node.id,
          ...serializeError(dnsErr),
        });
        dnsErrorMessage = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
      }
    }

    throwIfProviderRequestAborted(publishContext);
    const finalUpdate = await db
      .update(schema.nodes)
      .set({
        cloudProvider: providerResult.providerName,
        credentialSource: providerResult.credentialSource,
        credentialAttributionUserId: attributionUserId,
        credentialAttributionProjectId:
          providerResult.credentialSource === 'project' ? attributionProjectId : null,
        credentialAttributionSource: providerResult.credentialSource,
        providerInstanceId: vm.id,
        ...observedHardwareDbValues(vm),
        runtimeTerminationConfirmedAt: null,
        ipAddress: vm.ip || null,
        backendDnsRecordId,
        status: dnsErrorMessage ? 'error' : 'running',
        healthStatus: dnsErrorMessage ? 'unhealthy' : 'stale',
        errorMessage: dnsErrorMessage
          ? truncateNodeErrorMessage(`Backend DNS record creation failed: ${dnsErrorMessage}`)
          : null,
        updatedAt: new Date().toISOString(),
        cleanupBlockedSince: null,
        cleanupBlockedReason: null,
        cleanupBlockedAlertedAt: null,
      })
      .where(creatingProvisioningPredicate(node, provisioningRuntimeIncarnationId, vm.id))
      .run();
    if (!d1WriteChanged(finalUpdate)) {
      await cleanupCreatedVmAfterProvisioningRace({
        node,
        env,
        provider,
        providerInstanceId: vm.id,
        runtimeIncarnationId: provisioningRuntimeIncarnationId,
        backendDnsRecordId,
        providerContext: publishContext,
      });
      throw new Error('Node lifecycle changed before running state could be published');
    }
    throwIfProviderRequestAborted(publishContext);
    return { allocationConfirmed: true };
  } catch (err) {
    await handleNodeProvisioningFailure(err, {
      env, node, options, durable, db, tunnelJournaled, provisioningRuntimeIncarnationId, tunnelPhase, providerCreateRequested, providerContext, attemptedProvider, resolvedCredentialBinding, providerCreateRejected, providerAllocationRejected, providerRejectionProofAt, rejectedPlacementPredicate,
    });
  }
}
