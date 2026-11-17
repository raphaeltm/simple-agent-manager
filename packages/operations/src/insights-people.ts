/**
 * Insights · People (slice P, idea 01M7HTS38KX2G78JD0ESAGMKKH): where a project's work waits on
 * people. The one shared read behind the Insights page's People tab (policy 5cb362e8).
 *
 * Flow, not people: this read never counts what anyone produced. It reports what is waiting on
 * whom now, how long review requests wait for a first review (per project), and how often an ask
 * was answered by the person first asked.
 *
 * Everything is derived at read time:
 * - waiting on: open `asks` (questions, reviews, human tasks) grouped by who they wait on;
 * - review pickup: `pull_request_review_requests`, written by the GitHub webhook ingest;
 * - first person: closed `asks` and their `ask_activity` reassignment rows.
 *
 * Round trips (rule 60, budget 4 in the Insights spec): authorization 1; settings 0 or 1 (the
 * per-isolate admin-settings cache); one D1 `batch()` of five statements 1. At most 3, measured in
 * `insights-people.test.ts`. If the batch fails as a whole each statement is retried alone, so one
 * bad section cannot blank the page; that rare degraded path costs five more and is logged.
 *
 * Work bounds (rule 81): waiting-on returns one row per waiter for counts and at most `listed`
 * items per waiter, so its size is members x listed whatever the backlog. Review pickup scans at
 * most `peopleReviewScanCap` cycles (default 2,000, newest first) through the
 * `(project_id, requested_at)` index and says when the cap cut the range. First person scans the
 * project's closed asks once through `idx_asks_project_status`; a 10k-closed-ask project is one
 * indexed pass with two indexed `ask_activity` probes per row in the range.
 */
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_PEOPLE_ASK_KINDS,
  type InsightsPeopleSection,
  type InsightsReviewPickup,
  type InsightsWaitingGroup,
  isInsightsRange,
  type ProjectPeopleResponse,
} from '@simple-agent-manager/shared';
import { log } from '@simple-agent-manager/worker-core';
import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { OperationError } from './errors';
import { parseInsightsRows, runInsightsBatch } from './insights-batch';
import { flowWindow } from './insights-flow';
import { getInsightsPageLimits } from './insights-page-settings';
import {
  firstPersonStatement,
  reviewCyclesStatement,
  reviewRecordedSinceStatement,
  waitingGroupsStatement,
  waitingItemsStatement,
} from './insights-people-sql';
import { nearestRankPercentile } from './insights-phase-timings';
import type { OperationContext } from './types';

export interface ProjectPeopleInput {
  projectId: string;
  /** `7d`, `30d` or `90d`; omitted means `DEFAULT_INSIGHTS_RANGE`. */
  range?: unknown;
  /** Test seam: the instant the range ends at. */
  nowMs?: number;
}

const EVENT = 'insights_people';
type BatchKey = 'groups' | 'items' | 'reviews' | 'recordedSince' | 'firstPerson';
const SECTION_OF: Record<BatchKey, InsightsPeopleSection> = {
  groups: 'waiting',
  items: 'waiting',
  reviews: 'reviews',
  recordedSince: 'reviews',
  firstPerson: 'first_person',
};
const UNASSIGNED = 'unassigned';

/** The largest epoch milliseconds a `Date` can hold: a larger stored value is a malformed row. */
const MAX_DATE_MS = 8_640_000_000_000_000;
const epochMs = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_DATE_MS));
const isoTime = v.pipe(
  v.string(),
  v.check((value) => Number.isFinite(Date.parse(value)), 'not a timestamp')
);
const count = v.pipe(v.number(), v.minValue(0));

const GroupRowSchema = v.object({
  waiter: v.nullable(v.pipe(v.string(), v.minLength(1))),
  open: v.pipe(count, v.minValue(1)),
  blocking: v.nullish(count),
  oldest: epochMs,
  name: v.nullish(v.string()),
});
const ItemRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(INSIGHTS_PEOPLE_ASK_KINDS),
  blocking: v.nullish(v.number()),
  title: v.nullable(v.string()),
  created_at: epochMs,
  claimed: v.number(),
  waiter: v.nullable(v.string()),
  readable: v.number(),
  can_reassign: v.number(),
});
const ReviewRowSchema = v.object({
  requested_at: isoTime,
  first_review_at: v.nullable(isoTime),
});
const RecordedSinceSchema = v.object({ first: v.nullable(isoTime) });
const FirstPersonSchema = v.object({ closed: count, first_person: v.nullish(count) });

export async function projectPeople(
  ctx: OperationContext,
  input: ProjectPeopleInput
): Promise<ProjectPeopleResponse> {
  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  const range = input.range === undefined ? DEFAULT_INSIGHTS_RANGE : input.range;
  if (!isInsightsRange(range)) {
    throw new OperationError('invalid_input', 'range must be one of 7d, 30d, 90d');
  }
  await authorizeProjectOperation(ctx, projectId);
  const limits = await getInsightsPageLimits(ctx);
  const nowMs = input.nowMs ?? Date.now();
  const w = flowWindow(projectId, range, nowMs);
  const until = new Date(nowMs).toISOString();
  const viewerId = ctx.actor.userId;
  const listed = limits.peopleWaitingItemsListed;
  const reviewCap = limits.peopleReviewScanCap;

  const unavailable = new Set<InsightsPeopleSection>();
  const rows = await runInsightsBatch<BatchKey>(
    ctx,
    EVENT,
    projectId,
    {
      groups: waitingGroupsStatement(projectId, nowMs),
      items: waitingItemsStatement(
        projectId,
        nowMs,
        viewerId,
        ctx.ports.inbox.rolesWithCapability('task:write'),
        listed
      ),
      reviews: reviewCyclesStatement(projectId, w.since, until, reviewCap),
      recordedSince: reviewRecordedSinceStatement(projectId),
      firstPerson: firstPersonStatement(projectId, w.sinceMs, nowMs),
    },
    (key, error) => {
      log.error(`${EVENT}.section_failed`, {
        projectId,
        section: SECTION_OF[key],
        error: error instanceof Error ? error.message : String(error),
        action: 'section_unavailable',
      });
      unavailable.add(SECTION_OF[key]);
    }
  );

  return {
    projectId,
    range,
    since: w.since,
    until,
    waiting: buildWaiting(rows.groups, rows.items, projectId, viewerId, nowMs, listed, unavailable),
    reviewPickup: buildReviewPickup(rows.reviews, rows.recordedSince, projectId, reviewCap),
    firstPerson: buildFirstPerson(rows.firstPerson, projectId),
    unavailable: [...unavailable],
    generatedAt: new Date().toISOString(),
  };
}

function buildWaiting(
  groupRows: Record<string, unknown>[] | undefined,
  itemRows: Record<string, unknown>[] | undefined,
  projectId: string,
  viewerId: string,
  nowMs: number,
  listed: number,
  unavailable: Set<InsightsPeopleSection>
): ProjectPeopleResponse['waiting'] {
  if (!groupRows) {
    unavailable.add('waiting');
    return { groups: [], total: 0, listed };
  }
  const groups = new Map<string, InsightsWaitingGroup>();
  for (const row of parseInsightsRows(
    groupRows,
    GroupRowSchema,
    EVENT,
    'waiting_group',
    projectId
  )) {
    const key = row.waiter ?? UNASSIGNED;
    groups.set(key, {
      key,
      kind: row.waiter ? 'person' : 'unassigned',
      userId: row.waiter,
      name: row.waiter ? row.name?.trim() || null : null,
      you: row.waiter === viewerId,
      open: row.open,
      blocking: row.blocking ?? 0,
      oldestAgeMs: Math.max(0, nowMs - row.oldest),
      items: [],
    });
  }
  for (const row of parseInsightsRows(
    itemRows,
    ItemRowSchema,
    EVENT,
    'waiting_item',
    projectId,
    'id'
  )) {
    const group = groups.get(row.waiter ?? UNASSIGNED);
    if (!group || group.items.length >= listed) continue;
    const readable = row.readable === 1;
    group.items.push({
      ref: readable ? `ask:${row.id}` : null,
      title: readable ? row.title : null,
      kind: row.kind,
      blocking: (row.blocking ?? 0) > 0,
      claimed: row.claimed === 1,
      createdAt: new Date(row.created_at).toISOString(),
      ageMs: Math.max(0, nowMs - row.created_at),
      canReassign: readable && row.can_reassign === 1,
    });
  }
  // A failed item read leaves the counts; the page says the list could not be loaded.
  if (!itemRows) unavailable.add('waiting');
  const list = [...groups.values()].sort(
    (a, b) => b.oldestAgeMs - a.oldestAgeMs || a.key.localeCompare(b.key)
  );
  return { groups: list, total: list.reduce((sum, group) => sum + group.open, 0), listed };
}

function buildReviewPickup(
  reviewRows: Record<string, unknown>[] | undefined,
  sinceRows: Record<string, unknown>[] | undefined,
  projectId: string,
  cap: number
): InsightsReviewPickup {
  const first =
    parseInsightsRows(sinceRows, RecordedSinceSchema, EVENT, 'review_since', projectId)[0]?.first ??
    null;
  const recordedSince = first ? new Date(first).toISOString() : null;
  const parsed = parseInsightsRows(reviewRows, ReviewRowSchema, EVENT, 'review_cycle', projectId);
  const scanned = parsed.slice(0, cap);
  const durations: number[] = [];
  let waiting = 0;
  for (const row of scanned) {
    if (!row.first_review_at) {
      waiting += 1;
      continue;
    }
    const ms = Date.parse(row.first_review_at) - Date.parse(row.requested_at);
    if (ms >= 0) durations.push(ms);
  }
  if (durations.length === 0 || !recordedSince) {
    return { state: 'not_recorded', waiting, recordedSince };
  }
  durations.sort((a, b) => a - b);
  return {
    state: 'recorded',
    samples: durations.length,
    medianMs: nearestRankPercentile(durations, 0.5),
    p90Ms: nearestRankPercentile(durations, 0.9),
    waiting,
    recordedSince,
    truncated: (reviewRows?.length ?? 0) > cap,
  };
}

function buildFirstPerson(
  rows: Record<string, unknown>[] | undefined,
  projectId: string
): ProjectPeopleResponse['firstPerson'] {
  const row = parseInsightsRows(rows, FirstPersonSchema, EVENT, 'first_person', projectId)[0];
  const closed = row?.closed ?? 0;
  const firstPerson = Math.min(closed, row?.first_person ?? 0);
  return { closed, firstPerson, share: closed > 0 ? firstPerson / closed : null };
}
