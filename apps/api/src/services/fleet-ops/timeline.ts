/**
 * `ops_timeline`: one time-ordered event list for a task, chat session, workspace or node,
 * merged from every source in `DEFAULT_TIMELINE_SOURCES`.
 *
 * Disclosure (`.claude/rules/65`): each source is capped at `perSourceLimit`; the merge keeps
 * the most recent `limit` events. The result says which sources hit their cap, how many
 * merged events were dropped, and the `until` to pass to read further back.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { neutralizeUntrustedText } from '../../operations/untrusted-text';
import type { NodeAccess } from '../node-diagnostics-access';
import { type EntityGraph, type OpsEntityType, resolveEntityGraph } from './entity-graph';
import {
  DEFAULT_TIMELINE_SOURCES,
  type TimelineEvent,
  type TimelineScope,
  type TimelineSource,
} from './timeline-sources';

/** Default window when the caller gives no `since`. */
export const DEFAULT_TIMELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface TimelineRequest {
  readonly entityId: string;
  readonly entityType: OpsEntityType | null;
  readonly sinceMs?: number;
  readonly untilMs?: number;
  readonly limit: number;
  readonly perSourceLimit: number;
  readonly graphRowCap: number;
  readonly textMaxLength: number;
  readonly nodeAccess: NodeAccess;
  readonly now?: number;
}

export interface TimelineSourceReport {
  readonly name: string;
  readonly events: number;
  readonly hitLimit: boolean;
  readonly error?: string;
}

export interface TimelineResult {
  readonly entityType: OpsEntityType;
  readonly entityId: string;
  readonly found: boolean;
  readonly window: { readonly since: string; readonly until: string };
  readonly events: readonly TimelineEvent[];
  readonly sources: readonly TimelineSourceReport[];
  readonly truncated: boolean;
  readonly droppedOlderEvents: number;
  /** Pass as `until` to read the events this page dropped. */
  readonly continueUntil: string | null;
  readonly graphCapped: readonly string[];
}

function scopeFor(
  graph: EntityGraph,
  sinceMs: number,
  untilMs: number,
  nodeAccess: NodeAccess
): TimelineScope {
  return {
    entityType: graph.entityType,
    entityId: graph.entityId,
    projectId: graph.projectId,
    taskIds: graph.taskIds,
    chatSessionIds: graph.chatSessionIds,
    workspaceIds: graph.workspaceIds,
    nodeIds: graph.nodeIds,
    sinceMs,
    untilMs,
    graph,
    nodeAccess,
  };
}

function boundText(event: TimelineEvent, maxLength: number): TimelineEvent {
  if (event.text === undefined) return event;
  const text = neutralizeUntrustedText(event.text);
  return {
    ...event,
    text: text.length > maxLength ? `${text.slice(0, maxLength)} [truncated by SAM]` : text,
  };
}

export async function buildTimeline(
  env: Env,
  request: TimelineRequest,
  sources: readonly TimelineSource[] = DEFAULT_TIMELINE_SOURCES
): Promise<TimelineResult> {
  const now = request.now ?? Date.now();
  const untilMs = request.untilMs ?? now;
  const sinceMs = request.sinceMs ?? untilMs - DEFAULT_TIMELINE_WINDOW_MS;
  const graph = await resolveEntityGraph(
    env,
    request.entityId,
    request.entityType,
    request.graphRowCap
  );
  const scope = scopeFor(graph, sinceMs, untilMs, request.nodeAccess);

  const settled = await Promise.allSettled(
    sources.map((source) => source.collect(env, scope, request.perSourceLimit))
  );
  const reports: TimelineSourceReport[] = [];
  const merged: TimelineEvent[] = [];
  settled.forEach((outcome, index) => {
    const name = sources[index]?.name ?? `source-${index}`;
    if (outcome.status === 'rejected') {
      const error =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      log.warn('fleet_ops.timeline_source_failed', {
        source: name,
        entityId: request.entityId,
        error,
      });
      reports.push({ name, events: 0, hitLimit: false, error });
      return;
    }
    const events = outcome.value.filter((event) => {
      const ms = Date.parse(event.at);
      return Number.isFinite(ms) && ms >= sinceMs && ms <= untilMs;
    });
    reports.push({
      name,
      events: events.length,
      hitLimit: outcome.value.length >= request.perSourceLimit,
    });
    merged.push(...events);
  });

  // Oldest first, with a total order so identical calls return identical pages.
  merged.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.source.localeCompare(b.source) ||
      a.kind.localeCompare(b.kind) ||
      JSON.stringify(a.ids).localeCompare(JSON.stringify(b.ids))
  );
  const dropped = Math.max(0, merged.length - request.limit);
  const page = merged.slice(dropped).map((event) => boundText(event, request.textMaxLength));
  const first = page[0];

  return {
    entityType: graph.entityType,
    entityId: graph.entityId,
    found: graph.found,
    window: { since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    events: page,
    sources: reports,
    truncated: dropped > 0 || reports.some((r) => r.hitLimit),
    droppedOlderEvents: dropped,
    continueUntil: dropped > 0 && first ? first.at : null,
    graphCapped: graph.capped,
  };
}
