import {
  hasAmbiguousLabel,
  type Provider,
  ProviderError,
  type ProviderRequestContext,
  type VMInstance,
} from '@simple-agent-manager/providers';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { GcpApiError, gcpApiErrorHint } from './gcp-errors';
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
 * A provider error code is kept only when it looks like a vocabulary code (`placement_error`,
 * `RESOURCE_EXHAUSTED`): letters and underscores. Digits, dots, colons and hyphens are refused
 * because project ids, resource names and URLs are made of them.
 */
const PROVIDER_CODE_SHAPE = /^[A-Za-z_]{2,64}$/;

interface SafeFailureFields {
  name: string;
  step?: string;
  statusCode?: unknown;
  providerName?: string;
  providerCode?: string;
  category?: string;
  message?: string;
}

/**
 * Fields of a provisioning failure that are safe to log and to show the node's owner.
 *
 * No raw message from an arbitrary error survives: a provisioning cause is almost always a
 * `ProviderError` whose `message` embeds the provider's raw response body (resource paths, zone
 * URLs, service-account emails of the credential's project, which can be the platform's), and a
 * generic error can carry SQL or bound parameters. So:
 * - `GcpApiError` -> the sanitizer's user-facing hint (no raw body);
 * - `ProviderError` -> its structured fields, message dropped;
 * - `NodeAllocationUncertainError` -> its own authored message, capped;
 * - any other `Error` -> its name only.
 */
function safeFailureFields(value: unknown): SafeFailureFields {
  if (value instanceof GcpApiError) {
    return {
      name: value.name,
      step: value.step,
      statusCode: value.statusCode,
      message: gcpApiErrorHint(value),
    };
  }
  if (value instanceof ProviderError) {
    return {
      name: value.name,
      providerName: value.providerName,
      statusCode: value.statusCode,
      providerCode: PROVIDER_CODE_SHAPE.test(value.providerCode ?? '')
        ? value.providerCode
        : undefined,
      category: value.category,
    };
  }
  if (value instanceof NodeAllocationUncertainError) {
    return { name: value.name, message: value.message.slice(0, ATTEMPT_ERROR_MESSAGE_MAX_CHARS) };
  }
  if (value instanceof Error) return { name: value.name };
  return { name: typeof value };
}

/** Log fields for one failed attempt, including the cause an uncertain-allocation error wraps. */
export function describeProvisioningAttemptFailure(error: unknown): Record<string, unknown> {
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    error: safeFailureFields(error),
    ...(cause === undefined ? {} : { cause: safeFailureFields(cause) }),
  };
}

/**
 * One-line safe summary of a provider failure, for messages that reach `nodes.error_message`
 * and `workspaces.error_message` through the durable intent's `lastError`
 * (`NodeLifecycleProvisioning.reportExhausted()`), e.g. `ProviderError (gcp, HTTP 403, PERMISSION_DENIED)`.
 */
export function summarizeProvisioningFailure(error: unknown): string {
  const fields = safeFailureFields(error);
  const status =
    typeof fields.statusCode === 'number'
      ? `HTTP ${fields.statusCode}`
      : fields.providerName
        ? 'no HTTP response' // providerFetch: request timeout or transport failure
        : undefined;
  const details = [
    fields.providerName,
    fields.step,
    status,
    fields.providerCode,
    fields.category === 'unknown' ? undefined : fields.category,
  ].filter((part): part is string => !!part);
  const head = details.length ? `${fields.name} (${details.join(', ')})` : fields.name;
  return fields.message ? `${head}: ${fields.message}` : head;
}

export interface DurableNodeAllocation {
  createdAt: number;
  initialIncarnationId: string;
  incarnationId: string;
  /**
   * Whether any attempt of this allocation may already have sent the provider create POST.
   * `false` is positive evidence that none did, so a resumed attempt may create. Anything else
   * (`true`, or `undefined` for intents persisted before this field existed) means a VM may
   * exist and a resume must reconcile the exact inventory instead of creating again.
   */
  providerCreateRequested?: boolean;
  /**
   * Durably records that a create POST is about to be sent, BEFORE it is sent. Must throw when
   * the record cannot be made, so an unrecorded create is never sent.
   */
  markProviderCreateRequested?: () => Promise<void>;
  /**
   * Withdraws that record after the provider proved its create request was never sent
   * (`isProviderCreateNotDispatched`), so the next attempt may create. Fenced on the attempt
   * that made the mark; must throw rather than leave the record ambiguous.
   */
  clearProviderCreateRequested?: () => Promise<void>;
}

/** True when a resumed attempt must reconcile inventory rather than create (see above). */
export function durableAllocationMayHaveCreated(allocation: DurableNodeAllocation): boolean {
  return allocation.providerCreateRequested !== false;
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
  const listed = exact[0];
  if (!listed) throw new NodeAllocationUncertainError();
  // Inventory reads may omit native hardware (GCP lists without machineTypes.get). Re-read the
  // exact instance by id for the observed identity, and require it to be the same resource with
  // the same exact ownership labels.
  const vm =
    listed.observedHardware.resources.source === 'observed'
      ? listed
      : await (provider.getObservedVM
          ? provider.getObservedVM(listed.id, context)
          : provider.getVM(listed.id, context));
  if (
    !vm ||
    vm.id !== listed.id ||
    !Object.entries(labels).every(
      ([key, value]) => !hasAmbiguousLabel(vm.labels, key) && vm.labels[key] === value
    )
  ) {
    throw new NodeAllocationUncertainError('Allocation inventory identity changed during recovery');
  }
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
