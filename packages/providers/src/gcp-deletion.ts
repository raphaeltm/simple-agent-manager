/**
 * GCP instance deletion: the synchronous `deleteVM` (send, then wait for the operation) and the
 * two-phase pair used by deadline-bounded callers (send without waiting; later read GCP's record
 * of the delete operation for that exact instance id). See `./vm-deletion.ts`.
 */
import { type GcpApiScope, pollGcpOperation } from './gcp-api';
import { findGcpInstanceByIdOrName } from './gcp-instance-lookup';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type { ProviderRequestContext } from './types';
import { ProviderError } from './types';
import { parseProviderJson } from './validation';
import { expectObject, optionalArray, optionalString, requireString } from './validation-core';
import { type GcpInstancePayload, validateGcpOperation } from './validation-gcp';
import type {
  VmDeletionRequestOptions,
  VmDeletionRequestResult,
  VmDeletionStatus,
  VmDeletionTicket,
} from './vm-deletion';

export interface GcpDeletionScope extends GcpApiScope {
  readonly projectId: string;
  readonly zones: readonly string[];
  readonly defaultZone: string;
}

interface GcpDeletionTicketBody {
  v: 1;
  provider: 'gcp';
  project: string;
  zone: string;
  instanceId: string;
  instanceName: string;
}

/**
 * The instance's zone, from its machineType URL (`zones/us-central1-a/machineTypes/e2-medium`),
 * then its `zone` URL, then the provider default.
 */
export function gcpInstanceZone(instance: GcpInstancePayload, defaultZone: string): string {
  const match = instance.machineType.match(/zones\/([^/]+)/);
  return match?.[1] || instance.zone?.split('/').pop() || defaultZone;
}

/** A GCP zone or numeric id: only these characters may reach a URL or filter expression. */
const GCP_ZONE_PATTERN = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/;
const GCP_NUMERIC_ID_PATTERN = /^[0-9]{1,20}$/;
/** Pages of a filtered operations list read before giving up (each holds up to 50). */
const GCP_DELETION_STATUS_MAX_PAGES = 5;
const GCP_NAME_PATTERN = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

function parseTicket(ticket: VmDeletionTicket): GcpDeletionTicketBody {
  let body: unknown;
  try {
    body = JSON.parse(ticket);
  } catch {
    throw new ProviderError('gcp', undefined, 'GCP deletion ticket is not valid JSON', {
      category: 'invalid_config',
    });
  }
  const root = expectObject(body, 'gcp', 'deletionTicket');
  const parsed = {
    v: root.v,
    provider: root.provider,
    project: requireString(root, 'project', 'gcp', 'deletionTicket'),
    zone: requireString(root, 'zone', 'gcp', 'deletionTicket'),
    instanceId: requireString(root, 'instanceId', 'gcp', 'deletionTicket'),
    instanceName: requireString(root, 'instanceName', 'gcp', 'deletionTicket'),
  };
  if (
    parsed.v !== 1 ||
    parsed.provider !== 'gcp' ||
    !GCP_ZONE_PATTERN.test(parsed.zone) ||
    !GCP_NUMERIC_ID_PATTERN.test(parsed.instanceId) ||
    !GCP_NAME_PATTERN.test(parsed.instanceName)
  ) {
    throw new ProviderError('gcp', undefined, 'GCP deletion ticket is malformed', {
      category: 'invalid_config',
    });
  }
  return parsed as GcpDeletionTicketBody;
}

async function sendInstanceDelete(
  scope: GcpDeletionScope,
  zone: string,
  instanceName: string,
  context?: ProviderRequestContext
): Promise<{ name: string } | null> {
  const headers = await scope.authHeaders(context);
  const url = `${scope.projectUrl}/zones/${zone}/instances/${instanceName}`;
  try {
    const res = await providerFetch(
      'gcp',
      url,
      { method: 'DELETE', headers },
      scope.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    return validateGcpOperation(await parseProviderJson(res, 'gcp', 'deleteVM'), 'deleteVM', {
      requireName: true,
    });
  } catch (err) {
    rethrowIfProviderRequestAborted(err, context);
    if (err instanceof ProviderError && err.statusCode === 404) return null;
    throw err;
  }
}

/** Delete and wait for GCP's operation to finish. Idempotent: a missing instance returns. */
export async function deleteGcpInstance(
  scope: GcpDeletionScope,
  id: string,
  context?: ProviderRequestContext
): Promise<void> {
  throwIfProviderRequestAborted(context);
  const instance = await findGcpInstanceByIdOrName(scope, scope.zones, id, context);
  if (!instance) return; // Idempotent — already deleted
  const zone = gcpInstanceZone(instance, scope.defaultZone);
  try {
    const op = await sendInstanceDelete(scope, zone, instance.name, context);
    if (!op) return;
    throwIfProviderRequestAborted(context);
    await pollGcpOperation(
      scope,
      `${scope.projectUrl}/zones/${zone}/operations/${op.name}`,
      { validationContext: 'pollOperation', timeoutSubject: 'GCP operation' },
      context
    );
  } catch (err) {
    rethrowIfProviderRequestAborted(err, context);
    if (err instanceof ProviderError && err.statusCode === 404) return;
    throw err;
  }
}

/**
 * Send the delete and return without polling. The ticket names this exact instance (numeric id),
 * and is handed to `beforeSend` before the DELETE leaves, so a caller that persists it can later
 * ask GCP whether that delete ever arrived.
 */
export async function requestGcpInstanceDeletion(
  scope: GcpDeletionScope,
  id: string,
  context?: ProviderRequestContext,
  options?: VmDeletionRequestOptions
): Promise<VmDeletionRequestResult> {
  throwIfProviderRequestAborted(context);
  const instance = await findGcpInstanceByIdOrName(scope, scope.zones, id, context);
  if (!instance) return { state: 'absent' };
  const zone = gcpInstanceZone(instance, scope.defaultZone);
  const ticketBody: GcpDeletionTicketBody = {
    v: 1,
    provider: 'gcp',
    project: scope.projectId,
    zone,
    instanceId: instance.id,
    instanceName: instance.name,
  };
  const ticket = JSON.stringify(ticketBody);
  // Refuse to send anything we could not confirm later.
  parseTicket(ticket);
  throwIfProviderRequestAborted(context);
  await options?.beforeSend?.(ticket);
  throwIfProviderRequestAborted(context);
  const op = await sendInstanceDelete(scope, zone, instance.name, context);
  // A 404 on the DELETE means the instance vanished between lookup and send: same as `deleteVM`.
  if (!op) return { state: 'absent' };
  return { state: 'requested', ticket };
}

/**
 * GCP's own record of deletions of the ticket's instance: the zone's delete operations whose
 * `targetId` is that numeric instance id. Instance ids are unique within a project, and GCP keeps
 * zonal operations queryable for days (verified 2026-11-14 on a four-day-old delete).
 *
 * - any DONE operation without error → `deleted`
 * - otherwise any unfinished operation → `in_progress`
 * - otherwise only failed operations → `failed`
 * - no operation at all → `not_requested` (the delete never arrived)
 */
export async function getGcpInstanceDeletionStatus(
  scope: GcpDeletionScope,
  ticket: VmDeletionTicket,
  context?: ProviderRequestContext
): Promise<VmDeletionStatus> {
  throwIfProviderRequestAborted(context);
  const body = parseTicket(ticket);
  if (body.project !== scope.projectId) return { state: 'wrong_scope' };
  const isThisDelete = (op: { targetId: string; operationType: string }) =>
    op.targetId === body.instanceId && op.operationType === 'delete';
  const headers = await scope.authHeaders(context);
  const operations: Array<{
    status: string;
    error?: { errors?: Array<{ code: string; message: string }> };
    targetId: string;
    operationType: string;
  }> = [];
  // A filtered list may return empty pages with a continuation; read a bounded number of them.
  // A record left unread after the last page is never taken as "not requested".
  let pageToken: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= GCP_DELETION_STATUS_MAX_PAGES) {
      throw new ProviderError(
        'gcp',
        undefined,
        `GCP delete operations for instance ${body.instanceId} span more than ${GCP_DELETION_STATUS_MAX_PAGES} pages`
      );
    }
    const params = new URLSearchParams({
      filter: `(operationType = "delete") (targetId = "${body.instanceId}")`,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await providerFetch(
      'gcp',
      `${scope.projectUrl}/zones/${body.zone}/operations?${params.toString()}`,
      { headers },
      scope.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const root = expectObject(
      await parseProviderJson(res, 'gcp', 'getVMDeletionStatus'),
      'gcp',
      'getVMDeletionStatus'
    );
    for (const [index, item] of (
      optionalArray(root, 'items', 'gcp', 'getVMDeletionStatus') ?? []
    ).entries()) {
      const where = `getVMDeletionStatus.items[${index}]`;
      const op = validateGcpOperation(item, where);
      const fields = expectObject(item, 'gcp', where);
      operations.push({
        ...op,
        targetId: requireString(fields, 'targetId', 'gcp', where),
        operationType: requireString(fields, 'operationType', 'gcp', where),
      });
    }
    // A conclusive record on an early page decides; only "nothing yet" needs the whole walk.
    if (operations.some((op) => isThisDelete(op) && (op.status !== 'DONE' || !op.error))) break;
    pageToken = optionalString(root, 'nextPageToken', 'gcp', 'getVMDeletionStatus');
    if (!pageToken) break;
  }
  // Never trust the server-side filter alone: only this instance's delete operations count.
  const deletes = operations.filter(isThisDelete);
  if (deletes.some((op) => op.status === 'DONE' && !op.error)) return { state: 'deleted' };
  if (deletes.some((op) => op.status !== 'DONE')) return { state: 'in_progress' };
  const failed = deletes.find((op) => op.error);
  if (failed) {
    const first = failed.error?.errors?.[0];
    return {
      state: 'failed',
      message: first ? `${first.code}: ${first.message}` : 'GCP delete operation failed',
      ...(first?.code ? { providerCode: first.code } : {}),
    };
  }
  return { state: 'not_requested' };
}
