/**
 * `ops_capture_debug_package` and its retention purge (policy a35180d5: raw node diagnostics
 * are bounded-retention, kept only in the private Operations project library).
 *
 * Capture pulls the VM agent's `/debug-package` tar.gz on the server and stores it at
 * `/debug-packages/<nodeId>/<timestamp>.tar.gz` in the Operations project library. The agent
 * then fetches it with `download_library_file`; the archive never passes through MCP.
 *
 * Library objects are encrypted whole (AES-GCM in `uploadFile`), so the archive is read into
 * memory before encryption. The read is capped: it stops and fails the moment the byte cap is
 * crossed, and refuses up front when the agent's Content-Length already exceeds it.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { deleteFiles, uploadFile } from '../file-library';
import { getUploadMaxBytes } from '../file-library-config';
import { openNodeDiagnosticDownload } from '../node-agent-diagnostics';
import { type NodeAccess, runNodeDiagnostic } from '../node-diagnostics-access';
import { configuredFeedbackProjectId } from '../platform-feedback-incident-config';
import type { FleetOpsSettings } from './settings';

export const DEBUG_PACKAGE_ROOT = '/debug-packages';
const DAY_MS = 24 * 60 * 60 * 1000;

export class DebugPackageTooLargeError extends Error {
  constructor(readonly capBytes: number) {
    super(`Debug package exceeds the ${capBytes}-byte cap (operations.debugPackageMaxBytes)`);
    this.name = 'DebugPackageTooLargeError';
  }
}

/** Reads a stream into one buffer, cancelling it as soon as more than `capBytes` arrive. */
export async function readStreamCapped(
  body: ReadableStream<Uint8Array> | null,
  capBytes: number
): Promise<ArrayBuffer> {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel('debug package byte cap exceeded').catch(() => undefined);
      throw new DebugPackageTooLargeError(capBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export function debugPackageDirectory(nodeId: string): string {
  return `${DEBUG_PACKAGE_ROOT}/${nodeId}`;
}

export interface DebugPackageCaptureContext {
  readonly operationsProjectId: string;
  readonly actorUserId: string;
  readonly taskId: string;
  readonly encryptionKey: string;
  readonly settings: FleetOpsSettings;
  readonly now?: number;
}

export async function captureDebugPackage(
  env: Env,
  node: { id: string; status: string },
  access: NodeAccess,
  ctx: DebugPackageCaptureContext
) {
  const capBytes = Math.min(ctx.settings.debugPackageMaxBytes, getUploadMaxBytes(env));
  const outcome = await runNodeDiagnostic(node, access, (nodeId, userId) =>
    openNodeDiagnosticDownload(nodeId, env, userId, '/debug-package')
  );
  if (outcome.status !== 'ok') return outcome;

  const response = outcome.value;
  const declared = Number(response.headers.get('Content-Length'));
  let data: ArrayBuffer;
  try {
    if (Number.isFinite(declared) && declared > capBytes) {
      await response.body?.cancel('debug package byte cap exceeded').catch(() => undefined);
      throw new DebugPackageTooLargeError(capBytes);
    }
    data = await readStreamCapped(response.body, capBytes);
  } catch (error) {
    if (error instanceof DebugPackageTooLargeError) {
      return {
        status: 'too_large' as const,
        capBytes,
        declaredBytes: Number.isFinite(declared) ? declared : null,
      };
    }
    throw error;
  }

  const capturedAt = new Date(ctx.now ?? Date.now());
  const filename = `${capturedAt.toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  const directory = debugPackageDirectory(node.id);
  const file = await uploadFile(
    drizzle(env.DATABASE, { schema }),
    env.R2,
    ctx.encryptionKey,
    env,
    ctx.operationsProjectId,
    ctx.actorUserId,
    filename,
    'application/gzip',
    data,
    {
      directory,
      uploadSource: 'agent',
      uploadTaskId: ctx.taskId,
      tags: ['debug-package'],
      description:
        `Raw, unredacted debug package from node ${node.id}. ` +
        `Deleted automatically after ${ctx.settings.debugPackageRetentionDays} day(s).`,
    }
  );
  return {
    status: 'ok' as const,
    fileId: file.id,
    filename,
    directory: file.directory,
    sizeBytes: data.byteLength,
    capBytes,
    expiresAt: new Date(
      capturedAt.getTime() + ctx.settings.debugPackageRetentionDays * DAY_MS
    ).toISOString(),
  };
}

/**
 * Deletes debug packages older than `operations.debugPackageRetentionDays`, oldest first, in
 * batches of `debugPackagePurgeBatchSize` (one select, then `deleteFiles` once per owning
 * project), until none are left or `debugPackagePurgeDeadlineMs` has passed.
 *
 * Throughput (`.claude/rules/81`): a batch is about five round trips, so the default 20 s
 * deadline clears thousands of packages per daily run. The outer probable input is the capture
 * rate limit: 20 per hour per superadmin, 480 per day each, so even several superadmins at the
 * limit fit in one run. A backlog the deadline cuts off continues the next day (`complete: false`).
 *
 * Only packages the capture tool created are eligible: files whose IDs a successful
 * `ops_capture_debug_package` audit row recorded (this covers packages left in a former
 * Operations project after the setting changed), plus, in case an audit write failed, agent
 * uploads under `/debug-packages/` in the current Operations project. A user's own upload into
 * that directory is never purged. A failed batch stops the run, so its rows are not re-selected
 * in a loop; the next run retries them.
 */
export async function purgeExpiredDebugPackages(
  env: Env,
  settings: FleetOpsSettings,
  now: number = Date.now(),
  clock: () => number = Date.now
) {
  const currentProjectId = (await configuredFeedbackProjectId(env)) ?? '';
  const cutoff = new Date(now - settings.debugPackageRetentionDays * DAY_MS).toISOString();
  const deadline = clock() + settings.debugPackagePurgeDeadlineMs;
  const db = drizzle(env.DATABASE, { schema });
  let deleted = 0;
  let failed = 0;
  let batches = 0;
  let complete = false;

  while (clock() < deadline) {
    const expired =
      (
        await env.DATABASE.prepare(
          `SELECT f.id, f.project_id
           FROM project_files f
           WHERE julianday(f.created_at) < julianday(?)
             AND (
               f.id IN (
                 SELECT json_extract(a.detail, '$.fileId') FROM operations_audit_log a
                 WHERE a.tool = 'ops_capture_debug_package' AND a.outcome = 'succeeded'
               )
               OR (f.project_id = ? AND f.upload_source = 'agent' AND f.directory LIKE ?)
             )
           ORDER BY julianday(f.created_at) ASC, f.id ASC
           LIMIT ?`
        )
          // The library stores directories normalized with a trailing slash.
          .bind(
            cutoff,
            currentProjectId,
            `${DEBUG_PACKAGE_ROOT}/%`,
            settings.debugPackagePurgeBatchSize
          )
          .all<{ id: string; project_id: string }>()
      ).results ?? [];
    if (expired.length === 0) {
      complete = true;
      break;
    }
    batches += 1;

    const byProject = new Map<string, string[]>();
    for (const row of expired) {
      byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row.id]);
    }
    let batchFailed = false;
    for (const [projectId, ids] of byProject) {
      try {
        deleted += (await deleteFiles(db, env.R2, projectId, ids)).length;
      } catch (error) {
        batchFailed = true;
        failed += ids.length;
        log.error('fleet_ops.debug_package_purge_failed', {
          projectId,
          files: ids.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (batchFailed) break;
  }

  return {
    retentionDays: settings.debugPackageRetentionDays,
    deleted,
    failed,
    batches,
    complete,
  };
}
