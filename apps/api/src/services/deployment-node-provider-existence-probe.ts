/**
 * One provider-existence probe of a running deployment node's VM, for the reconciliation in
 * `deployment-node-provider-existence.ts`.
 *
 * Absence is proven, never inferred (`.claude/rules/56`, `.claude/rules/58`, `.claude/rules/74`).
 * The only "absent" verdict is `getVM` returning null for the node's exact instance ID through
 * its PINNED placement credential: the exact encrypted credential generation the VM was created
 * with (`resolveStrictNodeTeardownAuthority`), so the "not found" comes from the account that owns
 * the VM. Every provider's `getVM` returns null only for its API's "not found" (Hetzner, Vultr,
 * DigitalOcean and Infomaniak a 404 on the instance; Scaleway a 404 in every zone; UpCloud its
 * not-found code; GCP a 404 in every zone and no match in the project-wide list) and throws on
 * everything else.
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
import { ProviderError } from '@simple-agent-manager/providers';

import type { Env } from '../env';
import {
  isCredentialRejection,
  resolveStrictNodeTeardownAuthority,
} from './node-teardown-authority';
import type { NodeDb, NodeRow } from './strict-node-deletion-shared';

export type ProviderExistenceInconclusiveReason =
  | 'credential_unresolved'
  | 'credential_not_pinned'
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
 * Ask the node's own provider account whether its exact instance still exists.
 * `signal` bounds the whole probe, credential resolution included.
 */
export async function probeDeploymentNodeInstance(
  env: Env,
  db: NodeDb,
  node: NodeRow,
  signal: AbortSignal
): Promise<ProviderExistenceVerdict> {
  const instanceId = node.providerInstanceId;
  if (!instanceId) {
    return {
      kind: 'inconclusive',
      reason: 'provider_error',
      message: 'node has no provider instance ID',
    };
  }
  let authority;
  try {
    authority = await resolveStrictNodeTeardownAuthority(db, node, node.userId, env);
  } catch (error) {
    return { kind: 'inconclusive', reason: 'credential_unresolved', message: errorMessage(error) };
  }
  if (authority.kind !== 'pinned') {
    return {
      kind: 'inconclusive',
      reason: 'credential_not_pinned',
      message:
        'the placement credential no longer resolves to its exact generation, so a "not found" ' +
        'could come from a different account',
    };
  }
  let instance;
  try {
    instance = await authority.providerResult.provider.getVM(instanceId, { signal });
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
  return instance === null ? { kind: 'absent' } : { kind: 'present' };
}
