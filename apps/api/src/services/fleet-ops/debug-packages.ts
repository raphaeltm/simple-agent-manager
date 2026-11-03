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
import { and, eq, like, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUploadMaxBytes } from '../file-library-config';
import { deleteFile, uploadFile } from '../file-library';
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
    directory,
    sizeBytes: data.byteLength,
    capBytes,
    expiresAt: new Date(
      capturedAt.getTime() + ctx.settings.debugPackageRetentionDays * DAY_MS
    ).toISOString(),
  };
}

/**
 * Deletes debug packages older than `operations.debugPackageRetentionDays` from the Operations
 * project library, oldest first, at most `debugPackagePurgeBatchSize` per run. Each delete is
 * isolated so one failure does not stop the rest.
 */
export async function purgeExpiredDebugPackages(
  env: Env,
  settings: FleetOpsSettings,
  now: number = Date.now()
) {
  const projectId = await configuredFeedbackProjectId(env);
  if (!projectId) return { skipped: 'no_operations_project' as const, deleted: 0, failed: 0 };
  const cutoff = new Date(now - settings.debugPackageRetentionDays * DAY_MS).toISOString();
  const db = drizzle(env.DATABASE, { schema });
  const files = schema.projectFiles;
  const expired = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.projectId, projectId),
        or(
          eq(files.directory, DEBUG_PACKAGE_ROOT),
          like(files.directory, `${DEBUG_PACKAGE_ROOT}/%`)
        ),
        sql`julianday(${files.createdAt}) < julianday(${cutoff})`
      )
    )
    .orderBy(sql`julianday(${files.createdAt}) ASC`, files.id)
    .limit(settings.debugPackagePurgeBatchSize);

  let deleted = 0;
  let failed = 0;
  for (const row of expired) {
    try {
      await deleteFile(db, env.R2, projectId, row.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      log.error('fleet_ops.debug_package_purge_failed', {
        projectId,
        fileId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    retentionDays: settings.debugPackageRetentionDays,
    deleted,
    failed,
    batchFull: expired.length >= settings.debugPackagePurgeBatchSize,
  };
}
