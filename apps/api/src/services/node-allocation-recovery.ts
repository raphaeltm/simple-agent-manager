import {
  hasAmbiguousLabel,
  type Provider,
  ProviderError,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { GcpApiError, sanitizeGcpError } from './gcp-errors';
import {
  buildNodeProviderLabels,
  resolveEnvironmentLabel,
  resolveInstallationId,
} from './node-provider-labels';

/** A transport interruption or empty inventory cannot establish that no VM was allocated. */
export class NodeAllocationUncertainError extends Error {
  constructor(
    message = 'Provider allocation is unresolved; exact resource reconciliation is required',
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'NodeAllocationUncertainError';
  }
}

/** Cap for the one error message we author ourselves and know is free of external detail. */
const ATTEMPT_ERROR_MESSAGE_MAX_CHARS = 200;

/**
 * Log-safe description of a failed provisioning attempt, including the provider error an
 * uncertain-allocation wrapper replaced.
 *
 * No raw message from an arbitrary error is logged: a provisioning cause is almost always a
 * `ProviderError` (from `providerFetch`/the GCP adapter) whose `message` can embed the provider's
 * raw response — resource paths, zone URLs, service-account emails — and a generic error could
 * carry SQL, bound parameters, or user-controlled text. So:
 * - `GcpApiError` → the sanitizer's operator hint (raw body stays server-side);
 * - `ProviderError` → its already-safe structured fields, message dropped;
 * - `NodeAllocationUncertainError` → its own authored message (the only message we control), capped;
 * - any other `Error` → name + statusCode only, message dropped.
 */
export function describeProvisioningAttemptFailure(error: unknown): Record<string, unknown> {
  const describe = (value: unknown): Record<string, unknown> => {
    if (value instanceof GcpApiError) {
      return {
        name: value.name,
        step: value.step,
        statusCode: value.statusCode,
        message: sanitizeGcpError(value, 'node-provisioning-attempt'),
      };
    }
    if (value instanceof ProviderError) {
      return {
        name: value.name,
        providerName: value.providerName,
        statusCode: value.statusCode,
        providerCode: value.providerCode,
        category: value.category,
      };
    }
    if (value instanceof NodeAllocationUncertainError) {
      return { name: value.name, message: value.message.slice(0, ATTEMPT_ERROR_MESSAGE_MAX_CHARS) };
    }
    if (value instanceof Error) {
      return { name: value.name, statusCode: (value as { statusCode?: unknown }).statusCode };
    }
    return { name: typeof value };
  };
  const cause = error instanceof Error ? error.cause : undefined;
  return { error: describe(error), ...(cause === undefined ? {} : { cause: describe(cause) }) };
}

export interface DurableNodeAllocation {
  createdAt: number;
  initialIncarnationId: string;
  incarnationId: string;
}

/** Only the exact persisted create incarnation may supply a lost provider response. */
export async function recoverNodeAllocation(
  provider: Provider,
  node: typeof schema.nodes.$inferSelect,
  env: Env,
  allocation: DurableNodeAllocation,
  context?: ProviderRequestContext
): Promise<VMInstance> {
  const installationId = resolveInstallationId(env);
  const environmentLabel = resolveEnvironmentLabel(env);
  if (!installationId || !environmentLabel)
    throw new NodeAllocationUncertainError('Allocation ownership scope is unavailable');
  const labels = buildNodeProviderLabels({
    nodeId: node.id,
    isDeploymentNode: false,
    installationId,
    environmentLabel,
    runtimeIncarnationId: allocation.incarnationId,
  });
  const servers = await provider.listVMs(labels, context);
  // Do not trust provider filtering. Every result must prove exact ownership locally.
  const exact = servers.filter((server) =>
    Object.entries(labels).every(
      ([key, value]) => !hasAmbiguousLabel(server.labels, key) && server.labels[key] === value
    )
  );
  if (exact.length !== 1)
    throw new NodeAllocationUncertainError(
      exact.length === 0
        ? 'Allocation inventory has no exact match; a second create is forbidden'
        : 'Allocation inventory has multiple exact matches; operator recovery is required'
    );
  const vm = exact[0];
  if (!vm) throw new NodeAllocationUncertainError();
  if (
    (node.providerInstanceId && node.providerInstanceId !== vm.id) ||
    vm.location !== node.vmLocation ||
    Date.parse(vm.createdAt) < Math.floor(allocation.createdAt / 1000) * 1000 ||
    Date.parse(vm.createdAt) > Date.now() ||
    vm.serverType !== node.providerInstanceType ||
    vm.observedHardware.serverType.source !== 'observed' ||
    vm.observedHardware.serverType.value !== node.providerInstanceType ||
    vm.observedHardware.resources.source !== 'observed' ||
    !Number.isFinite(Date.parse(vm.createdAt))
  ) {
    throw new NodeAllocationUncertainError(
      'Allocation inventory identity or native hardware is inconsistent'
    );
  }
  return vm;
}
