/**
 * One provider-existence probe of a running deployment node's VM, for the reconciliation in
 * `deployment-node-provider-existence.ts`.
 *
 * Absence is proven, never inferred (`.claude/rules/56`, `.claude/rules/58`, `.claude/rules/74`).
 * The only "absent" verdict is `getVM` returning null for the node's exact instance ID through
 * its PINNED placement credential: the exact encrypted credential generation the VM was created
 * with (`resolveStrictNodeTeardownAuthority`), so the "not found" comes from the account that owns
 * the VM (`resolvePinnedNodeProvider`; no other credential is ever resolved, so no fallback
 * decryption happens either). Every provider's `getVM` returns null only for its API's "not found" (Hetzner, Vultr,
 * DigitalOcean and Infomaniak a 404 on the instance; Scaleway a 404 in every zone; UpCloud its
 * not-found code; GCP a 404 in every zone and no match in a project-wide list whose every zone
 * answered, plus two unfiltered reads of the node's own zone: the instance GET and an ID/name-filtered
 * list) and throws on everything else.
 * Scaleway is never proven absent (`ABSENCE_UNPROVABLE_PROVIDERS`); an Infomaniak node outside its
 * client's region is never proven absent (`lookupCoveredLocations`).
 *
 * The confirming probe also reads the account's full instance list (`confirmAbsentFromInventory`).
 *
 * Everything else is inconclusive and can never release a node:
 * - no pinned credential (rotated, re-saved, legacy unbound node): a 404 through some other
 *   current credential is what a wrong-account lookup also returns (`proveNodeInstanceOwnership`);
 * - a refused credential (401/403), a rate limit (429), a timeout, a 5xx, a malformed response,
 *   an unknown provider or a credential that cannot be decrypted.
 *
 * Condition vs signal (`.claude/rules/74`): the condition is "this VM no longer exists"; the
 * signal is "the owning account's API says not found". They diverge right after creation on an
 * eventually consistent API and on a provider-side zone the lookup does not cover; the caller's
 * second, later confirmation covers the first, and every SAM provider's lookup covers the zones
 * SAM creates VMs in.
 */
import { type Provider, ProviderError } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import { isCredentialRejection, resolvePinnedNodeProvider } from './node-teardown-authority';
import type { NodeDb, NodeRow } from './strict-node-deletion-shared';

export type ProviderExistenceInconclusiveReason =
  | 'credential_unresolved'
  | 'credential_not_pinned'
  | 'location_not_covered'
  | 'provider_unsupported'
  | 'inventory_unavailable'
  | 'credential_rejected'
  | 'rate_limited'
  | 'timeout'
  | 'provider_unavailable'
  | 'provider_error';

export type ProviderExistenceVerdict =
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'inconclusive'; reason: ProviderExistenceInconclusiveReason; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Providers whose lookups cannot prove absence. Scaleway's `getVM` and `listVMs` both treat a 404
 * from any zone as "nothing there", so a fault that makes every request 404 (a wrong base URL, a
 * proxy) would read every node as gone in both sources at once. Its nodes are never released
 * here (tracked in tasks/backlog/2026-11-23-unpinned-deployment-nodes-provider-existence.md).
 */
const ABSENCE_UNPROVABLE_PROVIDERS: ReadonlySet<string> = new Set(['scaleway']);

/**
 * Where a region-bound client can see an instance. Infomaniak's client reads one region
 * (OpenStack servers are regional; a server in another region is a 404 there, and `createVM`
 * refuses any other region). Hetzner, DigitalOcean, Vultr and UpCloud look an instance up by ID
 * account-wide. GCP is handled by an exact lookup in the node's own zone (`getVMInLocation`).
 */
function lookupCoveredLocations(provider: Provider): readonly string[] | null {
  if (provider.name === 'infomaniak') return [provider.defaultLocation];
  return null;
}

const RATE_LIMIT_CODE = /rate_?limit|too_?many_?requests|quota|resource_?exhausted/i;

/** Name why a failed lookup proves nothing. Never returns "absent". */
export function classifyProviderLookupFailure(
  error: unknown,
  signal: AbortSignal
): ProviderExistenceInconclusiveReason {
  if (signal.aborted) return 'timeout';
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'timeout';
  }
  if (error instanceof ProviderError) {
    if (
      error.statusCode === 429 ||
      error.category === 'rate_limited' ||
      (error.providerCode !== undefined && RATE_LIMIT_CODE.test(error.providerCode))
    ) {
      return 'rate_limited';
    }
  }
  if (isCredentialRejection(error)) return 'credential_rejected';
  if (error instanceof ProviderError && error.statusCode !== undefined && error.statusCode >= 500) {
    return 'provider_unavailable';
  }
  return 'provider_error';
}

/**
 * Ask the node's own provider account whether its exact instance still exists. `signal` bounds
 * the provider lookup; credential resolution before it is local D1 reads and decryption.
 */
export async function probeDeploymentNodeInstance(
  env: Env,
  db: NodeDb,
  node: NodeRow,
  signal: AbortSignal,
  options: { confirming?: boolean } = {}
): Promise<ProviderExistenceVerdict> {
  const instanceId = node.providerInstanceId;
  if (!instanceId) {
    return {
      kind: 'inconclusive',
      reason: 'provider_error',
      message: 'node has no provider instance ID',
    };
  }
  let pinned;
  try {
    pinned = await resolvePinnedNodeProvider(db, node, env);
  } catch (error) {
    return { kind: 'inconclusive', reason: 'credential_unresolved', message: errorMessage(error) };
  }
  if (!pinned) {
    return {
      kind: 'inconclusive',
      reason: 'credential_not_pinned',
      message:
        'the placement credential no longer resolves to its exact generation, so a "not found" ' +
        'could come from a different account',
    };
  }
  const provider = pinned.provider;
  if (ABSENCE_UNPROVABLE_PROVIDERS.has(provider.name)) {
    return {
      kind: 'inconclusive',
      reason: 'provider_unsupported',
      message: `${provider.name} lookups cannot prove an instance absent`,
    };
  }
  // A VM in a location the lookup does not read is a "not found" there (an Infomaniak region
  // changed in configuration would otherwise read every node as gone).
  const covered = lookupCoveredLocations(provider);
  if (covered && (!node.vmLocation || !covered.includes(node.vmLocation))) {
    return {
      kind: 'inconclusive',
      reason: 'location_not_covered',
      message: `instance location ${node.vmLocation ?? '(none)'} is outside the locations the lookup reads`,
    };
  }
  let instance;
  try {
    instance = await provider.getVM(instanceId, { signal });
  } catch (error) {
    return {
      kind: 'inconclusive',
      reason: classifyProviderLookupFailure(error, signal),
      message: errorMessage(error),
    };
  }
  // A lookup that finished after the deadline is still an answer, but only "found" is safe to
  // accept late; a late null is treated like the timeout it raced.
  if (instance === null && signal.aborted) {
    return { kind: 'inconclusive', reason: 'timeout', message: 'lookup finished after deadline' };
  }
  // Anything visible under this ID, even an instance that does not look like ours, is "not
  // absent": this check only ever releases on a definitive not-found.
  if (instance !== null) return { kind: 'present' };
  if (provider.name === 'gcp') {
    // `getVM` reads a fixed zone list, then a project-wide list filtered on SAM's label. A VM in
    // another zone (a box's configured zone) whose label was removed is in neither, so the
    // node's own zone must also answer "not found", unfiltered.
    const zonal = await lookupInNodeLocation(provider, node, instanceId, signal);
    if (zonal) return zonal;
  }
  if (!options.confirming) return { kind: 'absent' };
  return await confirmAbsentFromInventory(provider, instanceId, signal);
}

/** Present or inconclusive from the node's own location, or null when it too says not found. */
async function lookupInNodeLocation(
  provider: Provider,
  node: NodeRow,
  instanceId: string,
  signal: AbortSignal
): Promise<ProviderExistenceVerdict | null> {
  if (!provider.getVMInLocation || !node.vmLocation) {
    return {
      kind: 'inconclusive',
      reason: 'location_not_covered',
      message: 'the node has no recorded location to look the instance up in',
    };
  }
  try {
    const instance = await provider.getVMInLocation(instanceId, node.vmLocation, { signal });
    if (instance !== null) return { kind: 'present' };
  } catch (error) {
    return {
      kind: 'inconclusive',
      reason: classifyProviderLookupFailure(error, signal),
      message: errorMessage(error),
    };
  }
  if (signal.aborted) {
    return { kind: 'inconclusive', reason: 'timeout', message: 'lookup finished after deadline' };
  }
  return null;
}

/**
 * The confirming answer needs a second, independent source: the same account's instance list,
 * read in full, must succeed and must not contain the instance. A fault that turns every lookup
 * into a 404 (a wrong API base URL, a proxy, a path change) fails the list too, so it can never
 * release every node of a provider at once.
 */
async function confirmAbsentFromInventory(
  provider: Provider,
  instanceId: string,
  signal: AbortSignal
): Promise<ProviderExistenceVerdict> {
  let instances;
  try {
    // Complete or nothing: a list cut short at a page limit is not proof (`requireComplete`).
    instances = await provider.listVMs(undefined, { signal }, { requireComplete: true });
  } catch (error) {
    const reason = classifyProviderLookupFailure(error, signal);
    return {
      kind: 'inconclusive',
      reason: reason === 'provider_error' ? 'inventory_unavailable' : reason,
      message: errorMessage(error),
    };
  }
  if (signal.aborted) {
    return {
      kind: 'inconclusive',
      reason: 'timeout',
      message: 'inventory finished after deadline',
    };
  }
  return instances.some((vm) => String(vm.id) === instanceId)
    ? { kind: 'present' }
    : { kind: 'absent' };
}
