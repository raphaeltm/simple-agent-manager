/**
 * Which ProjectData alarm sections a tick runs, and what each one cost.
 *
 * Before this module every tick ran all thirteen maintenance sections, whichever one the alarm was
 * set for (idea `01M27M86R544BQX86VZANZGSQ2`). On the SAM root object one stuck idle-timeout
 * candidate re-arms the alarm every 60 s, so storage safety alone upserted D1 telemetry ~1,440
 * times a day while nothing about storage had changed (2026-09-25 measurement).
 *
 * Gating must not recompute "is this section due?" at alarm time. Most schedule functions clamp
 * overdue work into the future (`max(raw, now + minDelay)`, heartbeat's `now + window`, mailbox's
 * `now + poll`) so they cannot re-arm the alarm in a hot loop; recomputed at the tick, every such
 * section would look not-due forever. Instead the scheduler remembers, per section, the EARLIEST
 * time any recalculation computed since that section last ran, and overwrites it only after the
 * section runs. A section therefore runs no later than today's alarm would have fired for it.
 *
 * The memory is persisted in `do_meta` (`serialize` / `restore`). A ProjectData object is evicted
 * whenever it idles for a few seconds: on staging (2026-09-25) every minute-spaced tick ran on a
 * fresh instance, so memory kept only in the isolate would have made every tick a full run.
 *
 * Safety nets, because a section whose schedule under-reports its own work used to be carried by
 * other sections' ticks:
 * - every tick first folds in a fresh schedule computation, so a state change no writer followed
 *   with a recalculation is still seen (at once for unclamped schedules, after the section's own
 *   minimum delay for clamped ones); if that computation fails, the tick runs everything;
 * - an object with no readable persisted memory runs everything on its first tick;
 * - a full run happens at least every `PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS`;
 * - `PROJECT_DATA_ALARM_SECTION_GATING_ENABLED=false` restores run-everything ticks.
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import {
  PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS,
  PROJECT_DATA_ALARM_SECTIONS,
  type ProjectDataAlarmSection,
  type ProjectDataAlarmSectionTimes,
} from './alarm-schedule';

const log = createModuleLogger('project_data.alarm');

export const DEFAULT_PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_ALARM_DUE_TOLERANCE_MS = 2_000;
export const DEFAULT_PROJECT_DATA_ALARM_SLOW_SECTION_MS = 1_000;

export interface ProjectDataAlarmGatingConfig {
  enabled: boolean;
  fullRunIntervalMs: number;
  dueToleranceMs: number;
  slowSectionMs: number;
}

export interface ProjectDataAlarmGatingEnv {
  PROJECT_DATA_ALARM_SECTION_GATING_ENABLED?: string;
  PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS?: string;
  PROJECT_DATA_ALARM_DUE_TOLERANCE_MS?: string;
  PROJECT_DATA_ALARM_SLOW_SECTION_MS?: string;
}

export function resolveProjectDataAlarmGatingConfig(
  env: ProjectDataAlarmGatingEnv
): ProjectDataAlarmGatingConfig {
  return {
    enabled: env.PROJECT_DATA_ALARM_SECTION_GATING_ENABLED?.trim().toLowerCase() !== 'false',
    fullRunIntervalMs: parsePositiveInt(
      env.PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS,
      DEFAULT_PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS
    ),
    dueToleranceMs: parsePositiveInt(
      env.PROJECT_DATA_ALARM_DUE_TOLERANCE_MS,
      DEFAULT_PROJECT_DATA_ALARM_DUE_TOLERANCE_MS
    ),
    slowSectionMs: parsePositiveInt(
      env.PROJECT_DATA_ALARM_SLOW_SECTION_MS,
      DEFAULT_PROJECT_DATA_ALARM_SLOW_SECTION_MS
    ),
  };
}

/**
 * Work one section can hand to a later section within the same tick. Waits resolve and wakes
 * materialize before prompt delivery claims, and the mailbox sweep re-queues unacked messages, so
 * that "a newly enqueued parent wake is dispatched in this same alarm turn" keeps holding.
 */
const SAME_TICK_CASCADES: Partial<
  Record<ProjectDataAlarmSection, readonly ProjectDataAlarmSection[]>
> = {
  mailbox_delivery_sweep: ['prompt_delivery'],
  project_event_wake_materialization: ['prompt_delivery'],
  task_waits: ['prompt_delivery'],
};

export type ProjectDataAlarmFullRunReason =
  'gating_disabled' | 'first_tick' | 'full_run_interval' | 'schedule_unavailable';

export interface ProjectDataAlarmTickPlan {
  mode: 'full' | 'gated';
  fullRunReason: ProjectDataAlarmFullRunReason | null;
  isDue(section: ProjectDataAlarmSection): boolean;
  /** Later sections that must run in this tick because `section` just ran. */
  cascadeFrom(section: ProjectDataAlarmSection): void;
}

/** `do_meta` key holding the scheduler's memory across Durable Object instances. */
export const PROJECT_DATA_ALARM_SCHEDULE_META_KEY = 'alarmSectionSchedule';
const PERSISTED_SCHEDULE_VERSION = 1;

/** Scheduling memory for one ProjectData object; persisted between instances by the caller. */
export class ProjectDataAlarmSectionScheduler {
  private readonly pending = new Map<ProjectDataAlarmSection, number>();
  private readonly failedUntil = new Map<ProjectDataAlarmSection, number>();
  private lastFullRunAt: number | null = null;

  /**
   * The memory a previous instance persisted. Anything missing or unreadable starts over, which
   * makes the next tick a full run — the safe direction.
   */
  static restore(serialized: string | null): ProjectDataAlarmSectionScheduler {
    const scheduler = new ProjectDataAlarmSectionScheduler();
    if (!serialized) return scheduler;
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized) as unknown;
    } catch (error) {
      log.warn('schedule_state_unreadable', {
        error: error instanceof Error ? error.message : String(error),
      });
      return scheduler;
    }
    if (!isJsonRecord(parsed) || parsed.v !== PERSISTED_SCHEDULE_VERSION) {
      log.warn('schedule_state_unreadable', { error: 'unexpected shape or version' });
      return scheduler;
    }
    const pending = isJsonRecord(parsed.pending) ? parsed.pending : {};
    const failedUntil = isJsonRecord(parsed.failedUntil) ? parsed.failedUntil : {};
    for (const section of PROJECT_DATA_ALARM_SECTIONS) {
      const due = pending[section];
      if (typeof due === 'number' && Number.isFinite(due)) scheduler.pending.set(section, due);
      const failed = failedUntil[section];
      if (typeof failed === 'number' && Number.isFinite(failed)) {
        scheduler.failedUntil.set(section, failed);
      }
    }
    if (typeof parsed.lastFullRunAt === 'number' && Number.isFinite(parsed.lastFullRunAt)) {
      scheduler.lastFullRunAt = parsed.lastFullRunAt;
    }
    return scheduler;
  }

  serialize(): string {
    return JSON.stringify({
      v: PERSISTED_SCHEDULE_VERSION,
      pending: Object.fromEntries(this.pending),
      failedUntil: Object.fromEntries(this.failedUntil),
      lastFullRunAt: this.lastFullRunAt,
    });
  }

  /**
   * Fold a fresh schedule computation in. Every section not in `consumed` keeps the earlier of its
   * remembered and fresh time. A section in `consumed` ran, starting at the mapped time, so its
   * memory is replaced — except for a remembered due time that fell between that start and `now`.
   * The run looked at state before that deadline arrived, and a recomputation after it passes is
   * clamped (heartbeat: a whole detection window later), so it stays due until a run starts after
   * it. A failed section is then held off until its retry floor.
   */
  observe(
    times: ProjectDataAlarmSectionTimes,
    consumed: ReadonlyMap<ProjectDataAlarmSection, number> = new Map(),
    now: number = Date.now()
  ): void {
    for (const section of PROJECT_DATA_ALARM_SECTIONS) {
      const fresh = times[section];
      const remembered = this.pending.get(section);
      const startedAt = consumed.get(section);
      let next: number | null;
      if (startedAt === undefined) {
        next =
          remembered === undefined
            ? fresh
            : fresh === null
              ? remembered
              : Math.min(remembered, fresh);
      } else {
        const unexamined =
          remembered !== undefined &&
          remembered >= startedAt &&
          remembered <= now &&
          fresh !== null &&
          fresh > remembered;
        next = unexamined ? remembered : fresh;
      }
      const failedUntil = this.failedUntil.get(section);
      if (failedUntil !== undefined) {
        if (failedUntil <= now) this.failedUntil.delete(section);
        else if (next !== null) next = Math.max(next, failedUntil);
      }
      if (next === null) this.pending.delete(section);
      else this.pending.set(section, next);
    }
  }

  /** Earliest remembered due time, so a recalculation can never push a section past it. */
  nextDueAt(): number | null {
    let min: number | null = null;
    for (const time of this.pending.values()) {
      if (min === null || time < min) min = time;
    }
    return min;
  }

  /** A section that threw is retried no sooner than the failed-section spacing. */
  recordFailure(section: ProjectDataAlarmSection, now: number = Date.now()): void {
    this.failedUntil.set(section, now + PROJECT_DATA_ALARM_FAILED_SECTION_RETRY_MS);
  }

  /**
   * `forcedFullRunReason` lets the caller demand a full run when it could not refresh the schedule
   * at the start of the tick — without that refresh the remembered times may be stale.
   */
  planTick(
    config: ProjectDataAlarmGatingConfig,
    now: number = Date.now(),
    forcedFullRunReason: ProjectDataAlarmFullRunReason | null = null
  ): ProjectDataAlarmTickPlan {
    const fullRunReason: ProjectDataAlarmFullRunReason | null = !config.enabled
      ? 'gating_disabled'
      : (forcedFullRunReason ??
        (this.lastFullRunAt === null
          ? 'first_tick'
          : now - this.lastFullRunAt >= config.fullRunIntervalMs
            ? 'full_run_interval'
            : null));
    if (fullRunReason !== null) {
      this.lastFullRunAt = now;
      return {
        mode: 'full',
        fullRunReason,
        isDue: () => true,
        cascadeFrom: () => {},
      };
    }

    const due = new Set<ProjectDataAlarmSection>();
    for (const [section, dueAt] of this.pending) {
      if (dueAt <= now + config.dueToleranceMs) due.add(section);
    }
    return {
      mode: 'gated',
      fullRunReason: null,
      isDue: (section) => due.has(section),
      cascadeFrom: (section) => {
        for (const target of SAME_TICK_CASCADES[section] ?? []) due.add(target);
      },
    };
  }
}

export interface SqlRowCounts {
  rowsRead: number;
  rowsWritten: number;
}

/**
 * Attributes SQLite work to whichever alarm section is running. `Date.now()` does not advance
 * during synchronous execution in Workers, so wall time alone reads ~0 ms for a section that spends
 * seconds in synchronous SQL; rows read/written are what those sections actually cost (and what
 * Durable Object SQLite bills).
 */
export interface SqlRowMeter {
  begin(): void;
  end(): SqlRowCounts;
}

/**
 * Wraps `SqlStorage` so cursors opened while a meter is active are counted. Every member is
 * forwarded — `exec` is the only one that observes anything — so the cast stays confined to this
 * boundary. Work that interleaves during an awaiting section's I/O is counted toward that section.
 */
export function createRowMeteredSqlStorage(sql: SqlStorage): {
  sql: SqlStorage;
  meter: SqlRowMeter;
} {
  let active: Array<{ rowsRead?: number; rowsWritten?: number }> | null = null;
  const metered = {
    exec(query: string, ...bindings: unknown[]) {
      const cursor = sql.exec(query, ...bindings);
      active?.push(cursor);
      return cursor;
    },
    get databaseSize() {
      return sql.databaseSize;
    },
    get Cursor() {
      return sql.Cursor;
    },
    get Statement() {
      return sql.Statement;
    },
  };
  return {
    sql: metered as unknown as SqlStorage,
    meter: {
      begin() {
        active = [];
      },
      end() {
        const cursors = active ?? [];
        active = null;
        let rowsRead = 0;
        let rowsWritten = 0;
        for (const cursor of cursors) {
          rowsRead += typeof cursor.rowsRead === 'number' ? cursor.rowsRead : 0;
          rowsWritten += typeof cursor.rowsWritten === 'number' ? cursor.rowsWritten : 0;
        }
        return { rowsRead, rowsWritten };
      },
    },
  };
}

export type ProjectDataAlarmSectionStatus = 'ran' | 'skipped_not_due' | 'failed';

export interface ProjectDataAlarmSectionOutcome extends SqlRowCounts {
  section: ProjectDataAlarmSection;
  status: ProjectDataAlarmSectionStatus;
  /** When the section began looking at state; `null` when it was skipped. */
  startedAt: number | null;
  /** Wall time; advances only across awaited I/O (see `SqlRowMeter`). */
  durationMs: number;
  error?: string;
}

/** Runs one tick's sections in isolation and reports them in one completion log. */
export class ProjectDataAlarmTick {
  private readonly outcomes: ProjectDataAlarmSectionOutcome[] = [];
  private readonly startedAt = Date.now();

  constructor(
    private readonly plan: ProjectDataAlarmTickPlan,
    private readonly config: ProjectDataAlarmGatingConfig,
    private readonly meter: SqlRowMeter,
    private readonly scheduler: ProjectDataAlarmSectionScheduler
  ) {}

  /**
   * A throwing section is logged and recorded as `failed` — distinguishable from `skipped_not_due`
   * and from an empty run — and never stops later sections (`.claude/rules/53`).
   */
  async run(
    section: ProjectDataAlarmSection,
    work: () => Promise<unknown> | unknown,
    onError?: (error: unknown) => void
  ): Promise<void> {
    if (!this.plan.isDue(section)) {
      this.outcomes.push({
        section,
        status: 'skipped_not_due',
        startedAt: null,
        durationMs: 0,
        rowsRead: 0,
        rowsWritten: 0,
      });
      return;
    }
    const startedAt = Date.now();
    this.meter.begin();
    let status: ProjectDataAlarmSectionStatus = 'ran';
    let error: string | undefined;
    try {
      await work();
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      this.scheduler.recordFailure(section);
      log.error(`${section}_failed`, { section, error });
      try {
        onError?.(err);
      } catch (handlerError) {
        log.error('section_failure_handler_failed', {
          section,
          error: handlerError instanceof Error ? handlerError.message : String(handlerError),
        });
      }
    }
    const rows = this.meter.end();
    this.outcomes.push({
      section,
      status,
      startedAt,
      durationMs: Date.now() - startedAt,
      ...rows,
      ...(error ? { error } : {}),
    });
    this.plan.cascadeFrom(section);
  }

  /** Sections that ran (or failed) this tick, with when each began — see `observe`. */
  consumedSections(): Map<ProjectDataAlarmSection, number> {
    const consumed = new Map<ProjectDataAlarmSection, number>();
    for (const outcome of this.outcomes) {
      if (outcome.startedAt !== null) consumed.set(outcome.section, outcome.startedAt);
    }
    return consumed;
  }

  complete(projectId: string | null): void {
    const ran = this.outcomes.filter((o) => o.status === 'ran');
    const failed = this.outcomes.filter((o) => o.status === 'failed');
    const executed = [...ran, ...failed];
    const slowest = executed.reduce<ProjectDataAlarmSectionOutcome | null>(
      (max, o) => (max === null || o.durationMs > max.durationMs ? o : max),
      null
    );
    for (const outcome of executed) {
      if (outcome.durationMs < this.config.slowSectionMs) continue;
      log.warn('section_slow', {
        projectId,
        section: outcome.section,
        status: outcome.status,
        durationMs: outcome.durationMs,
        rowsRead: outcome.rowsRead,
        rowsWritten: outcome.rowsWritten,
        thresholdMs: this.config.slowSectionMs,
      });
    }
    log.info('completed', {
      projectId,
      mode: this.plan.mode,
      fullRunReason: this.plan.fullRunReason,
      durationMs: Date.now() - this.startedAt,
      ranSections: ran.map((o) => o.section),
      failedSections: failed.map((o) => o.section),
      skippedSections: this.outcomes
        .filter((o) => o.status === 'skipped_not_due')
        .map((o) => o.section),
      slowestSection: slowest?.section ?? null,
      slowestSectionMs: slowest?.durationMs ?? null,
      rowsRead: executed.reduce((sum, o) => sum + o.rowsRead, 0),
      rowsWritten: executed.reduce((sum, o) => sum + o.rowsWritten, 0),
      sections: executed.map((o) => ({
        section: o.section,
        status: o.status,
        durationMs: o.durationMs,
        rowsRead: o.rowsRead,
        rowsWritten: o.rowsWritten,
        ...(o.error ? { error: o.error } : {}),
      })),
    });
  }
}
