/**
 * Whole-session resource timeline.
 *
 * A session's resource history is stored as immutable ~15-minute chunks, one
 * series per workspace lifetime (every wake provisions a fresh workspace). The
 * index returns every chunk of the session with its per-minute rollup, so the
 * client can draw the whole session from D1 alone and fetch full-resolution
 * chunks only for the window the user zooms into.
 */
import { and, count, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { errors } from '../middleware/error';
import { parseStoredResolvedReservationJson } from './resource-requirements-input';
import { readChunkPayload } from './workspace-resource-history';
import {
  parseWorkspaceResourceRollup,
  type WorkspaceResourceRollup,
} from './workspace-resource-rollup';

const DEFAULT_TIMELINE_MAX_CHUNKS = 1000;
/** `nodes.runtime` for Instant sessions, whose container runtime records no resource history yet. */
const UNSUPPORTED_RUNTIMES: ReadonlySet<string> = new Set(['cf-container']);

export interface ResourceTimelineChunk {
  id: string;
  workspaceId: string;
  startedAt: number;
  endedAt: number;
  sampleCount: number;
  gapCount: number;
  toolSpanCount: number;
  summary: unknown;
  completeness: unknown;
  /** Per-minute rollup; null for chunks uploaded before rollups existed. */
  rollup: WorkspaceResourceRollup | null;
}

export interface ResourceTimelineRun {
  workspaceId: string;
  nodeId: string | null;
  runtime: string | null;
  startedAt: number;
  endedAt: number;
  /** What the workspace reserved; null when unknown or unparseable. */
  reservation: { cpuMillis: number; memoryMb: number } | null;
}

export interface ResourceTimelineIndexResponse {
  sessionId: string;
  runs: ResourceTimelineRun[];
  /** Ascending by `startedAt`. */
  chunks: ResourceTimelineChunk[];
  totalChunkCount: number;
  /** Oldest chunks left out because the session exceeds `maxChunks`. */
  omittedChunkCount: number;
  maxChunks: number;
  /**
   * `unsupported` when nothing is recorded and the session's runtime does not
   * collect resource history; `pending` when nothing has been uploaded yet.
   */
  collection: 'collected' | 'pending' | 'unsupported';
  runtime: string | null;
}

export function getTimelineMaxChunks(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_RESOURCE_TIMELINE_MAX_CHUNKS, DEFAULT_TIMELINE_MAX_CHUNKS);
}

function jsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function timelineChunk(row: schema.WorkspaceResourceChunkRow): ResourceTimelineChunk {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    sampleCount: row.sampleCount,
    gapCount: row.gapCount,
    toolSpanCount: row.toolSpanCount,
    summary: jsonOrNull(row.summaryJson),
    completeness: jsonOrNull(row.completenessJson),
    rollup: parseWorkspaceResourceRollup(row.rollupJson),
  };
}

interface RunWorkspaceRow {
  id: string;
  node_id: string | null;
  resolved_reservation_json: string | null;
  runtime: string | null;
}

function reservationOf(row: RunWorkspaceRow): ResourceTimelineRun['reservation'] {
  try {
    const reservation = parseStoredResolvedReservationJson(row.resolved_reservation_json);
    return reservation ? { cpuMillis: reservation.cpuMillis, memoryMb: reservation.memoryMb } : null;
  } catch (error) {
    // A malformed reservation hides the reservation line for that run; it must not fail the index.
    log.warn('workspace_resource_timeline.reservation_skipped', {
      workspaceId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Workspaces behind the session's chunks, scoped to the project on both sides of the join. */
async function loadRunWorkspaces(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<Map<string, RunWorkspaceRow>> {
  const { results } = await env.DATABASE.prepare(
    `SELECT w.id, w.node_id, w.resolved_reservation_json, n.runtime
       FROM workspaces w
       LEFT JOIN nodes n ON n.id = w.node_id
      WHERE w.project_id = ?
        AND w.id IN (
          SELECT DISTINCT workspace_id
            FROM workspace_resource_chunks
           WHERE project_id = ? AND session_id = ?
        )`
  )
    .bind(projectId, projectId, sessionId)
    .all<RunWorkspaceRow>();
  return new Map(results.map((row) => [row.id, row]));
}

/** Runtime of the session's current workspace, used only to explain an empty timeline. */
async function loadSessionRuntime(
  env: Env,
  projectId: string,
  sessionId: string
): Promise<string | null> {
  const row = await env.DATABASE.prepare(
    `SELECT n.runtime
       FROM workspaces w
       JOIN nodes n ON n.id = w.node_id
      WHERE w.project_id = ? AND w.chat_session_id = ?
      ORDER BY w.created_at DESC
      LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<{ runtime: string | null }>();
  return row?.runtime ?? null;
}

function groupRuns(
  chunks: readonly ResourceTimelineChunk[],
  workspaces: ReadonlyMap<string, RunWorkspaceRow>
): ResourceTimelineRun[] {
  const runs = new Map<string, ResourceTimelineRun>();
  for (const chunk of chunks) {
    const existing = runs.get(chunk.workspaceId);
    if (existing) {
      existing.startedAt = Math.min(existing.startedAt, chunk.startedAt);
      existing.endedAt = Math.max(existing.endedAt, chunk.endedAt);
      continue;
    }
    const workspace = workspaces.get(chunk.workspaceId);
    runs.set(chunk.workspaceId, {
      workspaceId: chunk.workspaceId,
      nodeId: workspace?.node_id ?? null,
      runtime: workspace?.runtime ?? null,
      startedAt: chunk.startedAt,
      endedAt: chunk.endedAt,
      reservation: workspace ? reservationOf(workspace) : null,
    });
  }
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

export async function getSessionResourceTimeline(
  env: Env,
  input: { projectId: string; sessionId: string }
): Promise<ResourceTimelineIndexResponse> {
  const { projectId, sessionId } = input;
  const db = drizzle(env.DATABASE, { schema });
  const maxChunks = getTimelineMaxChunks(env);
  const scope = and(
    eq(schema.workspaceResourceChunks.projectId, projectId),
    eq(schema.workspaceResourceChunks.sessionId, sessionId)
  );

  // Newest first so that, past the cap, it is the oldest chunks that are left out (and disclosed).
  const rows = await db
    .select()
    .from(schema.workspaceResourceChunks)
    .where(scope)
    .orderBy(desc(schema.workspaceResourceChunks.startedAt), desc(schema.workspaceResourceChunks.id))
    .limit(maxChunks);

  let totalChunkCount = rows.length;
  if (rows.length >= maxChunks) {
    const [total] = await db.select({ value: count() }).from(schema.workspaceResourceChunks).where(scope);
    totalChunkCount = total?.value ?? rows.length;
  }

  const chunks: ResourceTimelineChunk[] = [];
  for (const row of rows) {
    try {
      chunks.push(timelineChunk(row));
    } catch (error) {
      log.warn('workspace_resource_timeline.chunk_skipped', {
        projectId,
        sessionId,
        chunkId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  chunks.reverse();

  if (chunks.length === 0) {
    const runtime = await loadSessionRuntime(env, projectId, sessionId);
    return {
      sessionId,
      runs: [],
      chunks,
      totalChunkCount,
      omittedChunkCount: 0,
      maxChunks,
      collection: runtime && UNSUPPORTED_RUNTIMES.has(runtime) ? 'unsupported' : 'pending',
      runtime,
    };
  }

  const runs = groupRuns(chunks, await loadRunWorkspaces(env, projectId, sessionId));
  return {
    sessionId,
    runs,
    chunks,
    totalChunkCount,
    omittedChunkCount: Math.max(0, totalChunkCount - rows.length),
    maxChunks,
    collection: 'collected',
    runtime: runs.at(-1)?.runtime ?? null,
  };
}

export async function getSessionResourceTimelineChunk(
  env: Env,
  input: { projectId: string; sessionId: string; chunkId: string }
) {
  const db = drizzle(env.DATABASE, { schema });
  const chunk = await db
    .select()
    .from(schema.workspaceResourceChunks)
    .where(
      and(
        eq(schema.workspaceResourceChunks.id, input.chunkId),
        eq(schema.workspaceResourceChunks.projectId, input.projectId),
        eq(schema.workspaceResourceChunks.sessionId, input.sessionId)
      )
    )
    .get();
  // Defence in depth: the predicate already scopes, but a missing or foreign chunk must look identical.
  if (!chunk || chunk.projectId !== input.projectId || chunk.sessionId !== input.sessionId) {
    throw errors.notFound('Resource history chunk');
  }
  return readChunkPayload(env, chunk);
}
