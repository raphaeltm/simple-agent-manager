/**
 * Two-phase provider deletion for strict node teardown (`strict-node-deletion.ts`).
 *
 * A deadline-bounded caller (the cleanup cron) cannot wait for a provider's long-running delete:
 * GCP takes 20 s to minutes to finish an instance delete, and the cron gives a candidate seconds.
 * In `request` mode the delete is sent and the call returns `deletion_pending`; a later call reads
 * the provider's own record of that deletion and only then is termination proof written.
 *
 * The record (`nodes.provider_deletion_requested_at`, `nodes.provider_deletion_json`) is written
 * BEFORE the delete is sent, by the same exact-incarnation compare-and-set that fences proof, so a
 * delete cut off mid-flight can still be confirmed, or shown never to have arrived. It is bound to
 * the provider instance id and runtime incarnation it was written for, and ignored otherwise.
 *
 * Proof honesty: `deleted` comes only from the provider's record of a completed, error-free
 * deletion of that exact instance (GCP: a DONE delete operation whose `targetId` is the instance's
 * numeric id). A sent request is never proof, and neither is "not found" through a credential that
 * did not place the node (`node-teardown-authority.ts`).
 */
import {
  type Provider,
  type ProviderRequestContext,
  type VmDeletionStatus,
  type VmDeletionTicket,
} from '@simple-agent-manager/providers';
import { and, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema';
import { log } from '../lib/logger';
import { isCredentialRejection, NodeTeardownBlockedError } from './node-teardown-authority';
import {
  exactNodeIncarnationPredicate,
  type NodeDb,
  type NodeRow,
} from './strict-node-deletion-shared';

/** `wait`: delete and wait (interactive callers). `request`: start it and confirm later. */
export type ProviderDeletionMode = 'wait' | 'request';

/** What one provider deletion attempt achieved. */
export type ProviderDeletionOutcome = 'deleted' | 'deletion_pending';

export interface PendingProviderDeletion {
  ticket: VmDeletionTicket;
  requestedAt: string;
}

interface ProviderDeletionRecord {
  ticket: string;
  providerInstanceId: string;
  runtimeIncarnationId: string;
}

/**
 * The node's in-flight provider deletion, if its record belongs to this exact runtime. A record
 * that is malformed, or names another instance or incarnation, is ignored (and logged): it cannot
 * describe a deletion of this runtime (rules 41, 50).
 */
export function pendingProviderDeletionFor(node: NodeRow): PendingProviderDeletion | null {
  if (!node.providerDeletionJson && !node.providerDeletionRequestedAt) return null;
  let record: Partial<ProviderDeletionRecord> | null = null;
  try {
    const parsed: unknown = node.providerDeletionJson
      ? JSON.parse(node.providerDeletionJson)
      : null;
    record =
      parsed && typeof parsed === 'object' ? (parsed as Partial<ProviderDeletionRecord>) : null;
  } catch {
    record = null;
  }
  const requestedAt = node.providerDeletionRequestedAt;
  const ticket = typeof record?.ticket === 'string' ? record.ticket : '';
  const matches =
    record !== null &&
    ticket.length > 0 &&
    requestedAt !== null &&
    Number.isFinite(Date.parse(requestedAt)) &&
    !!node.providerInstanceId &&
    record.providerInstanceId === node.providerInstanceId &&
    !!node.runtimeIncarnationId &&
    record.runtimeIncarnationId === node.runtimeIncarnationId;
  if (!matches) {
    log.warn('node_teardown.provider_deletion_record_ignored', {
      nodeId: node.id,
      reason: record === null ? 'malformed' : 'identity_mismatch',
    });
    return null;
  }
  return { ticket, requestedAt: requestedAt as string };
}

/**
 * Write-ahead: record the deletion about to be sent, fenced on the exact incarnation that passed
 * every pre-delete guard. Throws (and so sends nothing) when the row moved.
 */
export async function recordProviderDeletionRequested(
  db: NodeDb,
  node: NodeRow,
  ticket: VmDeletionTicket
): Promise<void> {
  const requestedAt = new Date().toISOString();
  const record: ProviderDeletionRecord = {
    ticket,
    providerInstanceId: node.providerInstanceId ?? '',
    runtimeIncarnationId: node.runtimeIncarnationId ?? '',
  };
  const result = await db
    .update(schema.nodes)
    .set({
      providerDeletionRequestedAt: requestedAt,
      providerDeletionJson: JSON.stringify(record),
      updatedAt: requestedAt,
    })
    .where(
      and(
        exactNodeIncarnationPredicate(node),
        sql`${schema.nodes.runtimeTerminationConfirmedAt} IS NULL`
      )
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(`Provider deletion record CAS failed; nothing was sent: node=${node.id}`);
  }
  log.info('node_teardown.provider_deletion_requested', { nodeId: node.id, requestedAt });
}

/** Drop a record the provider showed to be void (never arrived, or failed). */
async function clearProviderDeletionRecord(
  db: NodeDb,
  node: NodeRow,
  reason: 'not_requested' | 'failed'
): Promise<void> {
  await db
    .update(schema.nodes)
    .set({ providerDeletionRequestedAt: null, providerDeletionJson: null })
    .where(
      and(
        eq(schema.nodes.id, node.id),
        sql`${schema.nodes.providerDeletionJson} IS ${node.providerDeletionJson}`
      )
    )
    .run();
  log.warn('node_teardown.provider_deletion_record_cleared', { nodeId: node.id, reason });
}

/**
 * Ask each provider handle (pinned credential, or the owner's current credentials in order) for
 * its record of the deletion. A ticket from another account answers `wrong_scope`, and a refused
 * credential cannot answer at all; both move on. The first conclusive answer wins. If none is
 * conclusive the last error is rethrown: an unread record is never read as absence.
 */
async function readProviderDeletionStatus(
  node: NodeRow,
  providers: readonly Provider[],
  ticket: VmDeletionTicket,
  context?: ProviderRequestContext
): Promise<VmDeletionStatus> {
  let lastError: unknown;
  for (const provider of providers) {
    if (!provider.getVMDeletionStatus) continue;
    try {
      const status = await provider.getVMDeletionStatus(ticket, context);
      if (status.state !== 'wrong_scope') return status;
    } catch (error) {
      if (context?.signal?.aborted) throw error;
      lastError = error;
      log.warn(
        isCredentialRejection(error)
          ? 'node_teardown.provider_deletion_status_rejected'
          : 'node_teardown.provider_deletion_status_failed',
        { nodeId: node.id, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }
  if (lastError !== undefined) throw lastError;
  throw new Error(
    `No current credential can read the provider deletion record of node ${node.id}; will retry`
  );
}

function unconfirmedError(node: NodeRow, pending: PendingProviderDeletion, detail: string) {
  return new NodeTeardownBlockedError(
    'teardown_deletion_unconfirmed',
    `node=${node.id} instance=${node.providerInstanceId}: the provider deletion requested at ` +
      `${pending.requestedAt} is still not confirmed (${detail}); the VM may still exist`
  );
}

/**
 * Resolve an in-flight deletion from the provider's record.
 *
 * - `deleted` → `deleted`; the caller writes termination proof.
 * - `in_progress` → `deletion_pending` while younger than `confirmMaxMs`, then the named blocked
 *   reason `teardown_deletion_unconfirmed`. An unreadable record past the bound is the same.
 * - `not_requested` / `failed` → the record is cleared and the attempt fails, so the next attempt
 *   runs the full guarded teardown again.
 */
export async function confirmPendingProviderDeletion(
  db: NodeDb,
  node: NodeRow,
  providers: readonly Provider[],
  pending: PendingProviderDeletion,
  confirmMaxMs: number,
  context?: ProviderRequestContext
): Promise<ProviderDeletionOutcome> {
  const overdue = Date.now() - Date.parse(pending.requestedAt) >= confirmMaxMs;
  let status: VmDeletionStatus;
  try {
    status = await readProviderDeletionStatus(node, providers, pending.ticket, context);
  } catch (error) {
    if (overdue && !context?.signal?.aborted) {
      throw unconfirmedError(
        node,
        pending,
        `its record could not be read: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw error;
  }
  switch (status.state) {
    case 'deleted':
      return 'deleted';
    case 'in_progress':
      if (overdue) throw unconfirmedError(node, pending, 'the provider still reports it running');
      return 'deletion_pending';
    case 'not_requested':
      await clearProviderDeletionRecord(db, node, 'not_requested');
      throw new Error(
        `Provider has no record of the deletion requested for node ${node.id}; ` +
          'cleared it so the next attempt runs teardown again'
      );
    case 'failed':
      await clearProviderDeletionRecord(db, node, 'failed');
      throw new Error(`Provider deletion of node ${node.id} failed: ${status.message}`);
    case 'wrong_scope':
      // `readProviderDeletionStatus` never returns `wrong_scope`.
      throw new Error(`No credential can read the deletion record of node ${node.id}`);
  }
}

/**
 * Delete through one provider handle. In `request` mode, a provider with two-phase support starts
 * the deletion (record written first) and returns `deletion_pending`; a provider without it, or
 * `wait` mode, deletes synchronously exactly as before.
 */
export async function sendProviderDeletion(
  db: NodeDb,
  node: NodeRow,
  provider: Provider,
  mode: ProviderDeletionMode,
  context?: ProviderRequestContext
): Promise<ProviderDeletionOutcome> {
  const instanceId = node.providerInstanceId;
  if (!instanceId) {
    throw new Error(`Cannot delete node ${node.id}: provider instance ID is missing`);
  }
  if (mode === 'request' && provider.requestVMDeletion && provider.getVMDeletionStatus) {
    const result = await provider.requestVMDeletion(instanceId, context, {
      beforeSend: (ticket) => recordProviderDeletionRequested(db, node, ticket),
    });
    // `absent` is the same quiet return `deleteVM` gives for an instance its lookup cannot find.
    return result.state === 'absent' ? 'deleted' : 'deletion_pending';
  }
  if (context) await provider.deleteVM(instanceId, context);
  else await provider.deleteVM(instanceId);
  return 'deleted';
}
