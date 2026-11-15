import {
  createProvider,
  type Provider,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';
import {
  DEFAULT_PROVIDER_ORPHAN_DESTROY_LIMIT,
  DEFAULT_PROVIDER_ORPHAN_MIN_AGE_MS,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { createGcpProviderForEnv } from '../services/gcp-provider-factory';
import { createGcpTokenProvider } from '../services/gcp-token-provider';
import {
  SAM_ENVIRONMENT_LABEL_KEY,
  SAM_INSTALLATION_LABEL_KEY,
  SAM_MANAGED_LABEL_KEY,
  SAM_MANAGED_LABEL_VALUE,
  SAM_NODE_LABEL_KEY,
} from '../services/node-provider-labels';
import { getPlatformCloudCredential } from '../services/platform-credentials';
import { buildProviderConfig, parseGcpCredential } from '../services/provider-credential-codecs';
import { parseMs, parsePositiveInt, resolveCleanupConfig } from './node-cleanup/shared';
import {
  listInventoryCredentials,
  markInventoryCredentialAttempted,
  resolveInventoryProvider,
} from './provider-orphan-credentials';
import { destroyEligibleCandidates, hasAmbiguousOwnershipLabels } from './provider-orphan-destroy';
import {
  type ClaimingNode,
  loadClaimingNodeStatuses,
  PROVIDER_ORPHAN_NODE_ID_PATTERN,
} from './provider-orphan-inventory';

export interface ProviderOrphanResult {
  enabled: boolean;
  skipped: boolean;
  skipReason: string | null;
  scanned: number;
  destroyed: number;
  skippedUnlabeled: number;
  skippedForeignManaged: number;
  skippedForeignEnv: number;
  skippedForeignInstallation: number;
  skippedUnattributedInstallation: number;
  skippedAmbiguousOwnership: number;
  skippedYoung: number;
  skippedClaimed: number;
  skippedAmbiguousClaim: number;
  errors: number;
}

export function emptyProviderOrphanResult(
  overrides: Partial<ProviderOrphanResult> = {}
): ProviderOrphanResult {
  return {
    enabled: true,
    skipped: false,
    skipReason: null,
    scanned: 0,
    destroyed: 0,
    skippedUnlabeled: 0,
    skippedForeignManaged: 0,
    skippedForeignEnv: 0,
    skippedForeignInstallation: 0,
    skippedUnattributedInstallation: 0,
    skippedAmbiguousOwnership: 0,
    skippedYoung: 0,
    skippedClaimed: 0,
    skippedAmbiguousClaim: 0,
    errors: 0,
    ...overrides,
  };
}

export interface OwnershipScope {
  environmentLabel: string;
  installationId: string;
}

export interface Candidate {
  serverId: string;
  nodeId: string;
  createdAt: string;
}

type ProviderResolution = { provider: Provider } | { result: ProviderOrphanResult };
type Discovery = { servers: VMInstance[] } | { result: ProviderOrphanResult };

export async function reconcileProviderOrphans(
  env: Env,
  now: Date,
  scope: OwnershipScope
): Promise<ProviderOrphanResult> {
  const result = emptyProviderOrphanResult();
  const minAgeMs = parseMs(env.PROVIDER_ORPHAN_MIN_AGE_MS, DEFAULT_PROVIDER_ORPHAN_MIN_AGE_MS);
  const destroyLimit = parsePositiveInt(
    env.PROVIDER_ORPHAN_DESTROY_LIMIT,
    DEFAULT_PROVIDER_ORPHAN_DESTROY_LIMIT
  );
  const deadline = Date.now() + resolveCleanupConfig(env).stoppedHandoffSweepBudgetMs;
  const resolution = await resolveProvider(env);
  if ('provider' in resolution) {
    await reconcileInventory(env, now, scope, resolution.provider, minAgeMs, destroyLimit, result);
  } else {
    Object.assign(result, resolution.result);
  }
  try {
    const credentials = await listInventoryCredentials(env);
    let lastAttempted: (typeof credentials)[number] | undefined;
    for (const credential of credentials) {
      if (Date.now() >= deadline || result.destroyed >= destroyLimit) break;
      try {
        const resolved = await resolveInventoryProvider(env, credential);
        if (resolved) {
          result.skipped = false;
          result.skipReason = null;
          await reconcileInventory(
            env,
            now,
            scope,
            resolved.provider,
            minAgeMs,
            destroyLimit,
            result
          );
        }
      } catch (error) {
        result.errors++;
        log.warn('provider_orphan.account_inventory_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      lastAttempted = credential;
    }
    if (lastAttempted) await markInventoryCredentialAttempted(env, lastAttempted);
  } catch (error) {
    result.errors++;
    log.warn('provider_orphan.credential_inventory_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

async function reconcileInventory(
  env: Env,
  now: Date,
  scope: OwnershipScope,
  provider: Provider,
  minAgeMs: number,
  destroyLimit: number,
  result: ProviderOrphanResult
): Promise<void> {
  const context = {
    signal: AbortSignal.timeout(resolveCleanupConfig(env).stoppedHandoffRequestTimeoutMs),
  };
  const discovery = await discoverServers(provider, scope, context);
  if ('result' in discovery) {
    result.errors += discovery.result.errors;
    result.skipped = true;
    result.skipReason = discovery.result.skipReason;
    return;
  }
  result.scanned += discovery.servers.length;
  const candidates = classifyCandidates(discovery.servers, scope, now.getTime() - minAgeMs, result);
  logOwnershipSkips(result);
  if (candidates.length === 0) return;
  const claims = await loadClaimsOrAbort(env, candidates, result);
  if ('result' in claims) {
    Object.assign(result, claims.result);
    return;
  }
  await destroyEligibleCandidates(
    env,
    provider,
    candidates,
    claims.rows,
    scope,
    minAgeMs,
    destroyLimit,
    result,
    context
  );
}

async function resolveProvider(env: Env): Promise<ProviderResolution> {
  try {
    const credential = await getPlatformCloudCredential(
      drizzle(env.DATABASE),
      getCredentialEncryptionKey(env)
    );
    if (!credential) {
      return {
        result: emptyProviderOrphanResult({
          skipped: true,
          skipReason: 'no-platform-credential',
        }),
      };
    }
    if (credential.provider === 'gcp') {
      const gcpCredential = parseGcpCredential(credential.decryptedToken);
      // Match installation catalog reads: platform credentials act as their creator,
      // without a SAM project scope. The token provider handles WIF and key credentials.
      const tokenProvider = createGcpTokenProvider(
        gcpCredential,
        {
          credentialSource: 'platform',
          userId: credential.createdBy ?? 'installation',
          projectId: null,
        },
        env
      );
      return { provider: await createGcpProviderForEnv(env, gcpCredential, tokenProvider) };
    }
    return {
      provider: createProvider(
        buildProviderConfig(credential.provider, credential.decryptedToken, env)
      ),
    };
  } catch (err) {
    log.error('provider_orphan.credential_resolution_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      result: emptyProviderOrphanResult({
        skipped: true,
        skipReason: 'credential-resolution-failed',
        errors: 1,
      }),
    };
  }
}

async function discoverServers(
  provider: Provider,
  scope: OwnershipScope,
  context: ProviderRequestContext
): Promise<Discovery> {
  try {
    return {
      servers: await provider.listVMs(
        {
          [SAM_MANAGED_LABEL_KEY]: SAM_MANAGED_LABEL_VALUE,
          [SAM_ENVIRONMENT_LABEL_KEY]: scope.environmentLabel,
          [SAM_INSTALLATION_LABEL_KEY]: scope.installationId,
        },
        context
      ),
    };
  } catch (err) {
    log.error('provider_orphan.list_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      result: emptyProviderOrphanResult({
        skipped: true,
        skipReason: 'provider-list-failed',
        errors: 1,
      }),
    };
  }
}

function classifyCandidates(
  servers: VMInstance[],
  scope: OwnershipScope,
  ageFloor: number,
  result: ProviderOrphanResult
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const server of servers) {
    const candidate = classifyCandidate(server, scope, ageFloor, result);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function classifyCandidate(
  server: VMInstance,
  scope: OwnershipScope,
  ageFloor: number,
  result: ProviderOrphanResult
): Candidate | null {
  const labels = server.labels ?? {};
  if (hasAmbiguousOwnershipLabels(labels)) {
    result.skippedAmbiguousOwnership++;
    return null;
  }
  if (labels[SAM_MANAGED_LABEL_KEY] !== SAM_MANAGED_LABEL_VALUE) {
    result.skippedForeignManaged++;
    return null;
  }
  if (!labels[SAM_ENVIRONMENT_LABEL_KEY]) {
    result.skippedUnlabeled++;
    return null;
  }
  if (labels[SAM_ENVIRONMENT_LABEL_KEY] !== scope.environmentLabel) {
    result.skippedForeignEnv++;
    return null;
  }
  if (!labels[SAM_INSTALLATION_LABEL_KEY]) {
    result.skippedUnattributedInstallation++;
    return null;
  }
  if (labels[SAM_INSTALLATION_LABEL_KEY] !== scope.installationId) {
    result.skippedForeignInstallation++;
    return null;
  }
  const nodeId = labels[SAM_NODE_LABEL_KEY];
  if (!nodeId || !PROVIDER_ORPHAN_NODE_ID_PATTERN.test(nodeId)) {
    result.skippedUnlabeled++;
    return null;
  }
  const createdMs = Date.parse(server.createdAt);
  if (!Number.isFinite(createdMs) || createdMs > ageFloor) {
    result.skippedYoung++;
    return null;
  }
  return { serverId: server.id, nodeId, createdAt: server.createdAt };
}

function logOwnershipSkips(result: ProviderOrphanResult): void {
  const skipped =
    result.skippedForeignManaged +
    result.skippedForeignEnv +
    result.skippedUnattributedInstallation +
    result.skippedForeignInstallation +
    result.skippedAmbiguousOwnership +
    result.skippedUnlabeled;
  if (skipped === 0) return;
  log.warn('provider_orphan.ownership_skipped', {
    reason: 'provider resources were outside exact installation and control-plane scope',
    foreignManaged: result.skippedForeignManaged,
    foreignEnvironment: result.skippedForeignEnv,
    unattributed: result.skippedUnattributedInstallation,
    foreign: result.skippedForeignInstallation,
    ambiguous: result.skippedAmbiguousOwnership,
    malformedOrMissingScope: result.skippedUnlabeled,
    action: 'preserved without calling the provider delete boundary',
  });
}

async function loadClaimsOrAbort(
  env: Env,
  candidates: Candidate[],
  result: ProviderOrphanResult
): Promise<{ rows: Map<string, ClaimingNode> } | { result: ProviderOrphanResult }> {
  try {
    return {
      rows: await loadClaimingNodeStatuses(env, [
        ...new Set(candidates.map((candidate) => candidate.nodeId.toLowerCase())),
      ]),
    };
  } catch (err) {
    log.error('provider_orphan.claim_lookup_failed', {
      error: err instanceof Error ? err.message : String(err),
      candidates: candidates.length,
    });
    return {
      result: {
        ...result,
        skipped: true,
        skipReason: 'claim-lookup-failed',
        errors: result.errors + 1,
      },
    };
  }
}
