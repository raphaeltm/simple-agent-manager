/**
 * Two-phase VM deletion for callers that cannot wait for a provider's long-running delete
 * (a cron tick with a wall-time budget). A provider that deletes asynchronously behind an
 * operation (GCP) starts the deletion and returns; a later call reads the provider's own record
 * of that deletion. Providers whose `deleteVM` already returns on acceptance do not implement it.
 *
 * Nothing here is termination proof by itself. `deleted` means the provider's record says this
 * exact instance was deleted; a sent request, or a request the caller merely believes was sent,
 * is never `deleted`.
 */
import type { ProviderRequestContext } from './types';

/**
 * Opaque, provider-owned description of one deletion: enough for the same provider to find its
 * record of it later (for GCP: project, zone, numeric instance id and name). Callers store it
 * verbatim and must not parse it.
 */
export type VmDeletionTicket = string;

export type VmDeletionRequestResult =
  /** The provider lookup found no such instance, exactly as `deleteVM` would return quietly. */
  | { state: 'absent' }
  /** The delete was sent and accepted; completion is read later with the ticket. */
  | { state: 'requested'; ticket: VmDeletionTicket };

export type VmDeletionStatus =
  /** The provider records a completed, error-free deletion of this exact instance. */
  | { state: 'deleted' }
  /** The provider records a deletion of this instance that has not finished. */
  | { state: 'in_progress' }
  /** The provider has no record of a deletion of this instance: the delete never arrived. */
  | { state: 'not_requested' }
  /** Every recorded deletion of this instance failed. */
  | { state: 'failed'; message: string; providerCode?: string }
  /** The ticket names a different account/project than this provider instance can read. */
  | { state: 'wrong_scope' };

export interface VmDeletionRequestOptions {
  /**
   * Called with the ticket after the instance is resolved and immediately before the delete is
   * sent. If it throws, nothing is sent. Callers persist the ticket here, so a delete that is
   * cut off mid-flight can still be confirmed (or proven never to have arrived) later.
   */
  beforeSend?: (ticket: VmDeletionTicket) => Promise<void>;
}

/** Optional two-phase deletion capability of a `Provider`. */
export interface ProviderVmDeletionRequests {
  /** Start deleting a VM without waiting for the provider's operation to finish. */
  requestVMDeletion?(
    id: string,
    context?: ProviderRequestContext,
    options?: VmDeletionRequestOptions
  ): Promise<VmDeletionRequestResult>;

  /** Read the provider's own record of a deletion started by `requestVMDeletion`. */
  getVMDeletionStatus?(
    ticket: VmDeletionTicket,
    context?: ProviderRequestContext
  ): Promise<VmDeletionStatus>;
}
