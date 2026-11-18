import { AsyncLocalStorage } from 'node:async_hooks';

import type {
  ProjectEventAdmissionOutcome,
  ProjectEventRecentStatus,
} from '@simple-agent-manager/shared';
import { createModuleLogger } from '@simple-agent-manager/worker-core';

import {
  addMessageIngestMetrics,
  emptyMessageIngestMetrics,
  type MessageIngestMetrics,
} from './message-ingest-metrics';

const log = createModuleLogger('project_data');
import { DEFAULT_ROW_USAGE_INTERVAL_MS, ROW_USAGE_LABEL_LIMIT } from './row-usage-config';
export { DEFAULT_ROW_USAGE_INTERVAL_MS, ROW_USAGE_LABEL_LIMIT } from './row-usage-config';

export interface RowUsageTotals {
  calls: number;
  rowsRead: number;
  rowsWritten: number;
  alarmWrites: number;
}
export interface RowUsageLabel extends RowUsageTotals {
  label: string;
}
const empty = (): RowUsageTotals => ({ calls: 0, rowsRead: 0, rowsWritten: 0, alarmWrites: 0 });
const context = new AsyncLocalStorage<{ owner: RowUsage; label: string }>();

/** Includes internal scheduled/workflow producers under their existing operation window. */
export function recordProjectEventAdmission(
  source: string,
  eventType: string,
  outcome: ProjectEventAdmissionOutcome
): void {
  context.getStore()?.owner.recordProjectEvent(source, eventType, outcome);
}

/** Instance-local counters only: never persists, arms an alarm, or schedules a timer. */
export class RowUsage {
  private readonly totals = new Map<string, RowUsageTotals>();
  private pending: {
    cursor: { readonly rowsRead?: number; readonly rowsWritten?: number };
    totals: RowUsageTotals;
  } | null = null;
  private windowStart = Date.now();
  intervalMs = DEFAULT_ROW_USAGE_INTERVAL_MS;
  private messageIngest = emptyMessageIngestMetrics();
  private eventAdmissions: NonNullable<ProjectEventRecentStatus['admission']> = {
    windowStart: Date.now(),
    windowEnd: Date.now(),
    skipUnsubscribedGitHubCi: true,
    counts: {},
    overflowCalls: 0,
  };

  recordProjectEvent(
    source: string,
    eventType: string,
    outcome: ProjectEventAdmissionOutcome
  ): void {
    // Only normalized protocol names, never payloads, delivery IDs or metadata. The
    // existing label ceiling bounds cardinality; excess types disclose an overflow count.
    const key = `${source.trim()}:${eventType.trim()}`;
    let counter = this.eventAdmissions.counts[key];
    if (!counter && Object.keys(this.eventAdmissions.counts).length >= ROW_USAGE_LABEL_LIMIT) {
      this.eventAdmissions.overflowCalls++;
      return;
    }
    counter ??= this.eventAdmissions.counts[key] = {
      calls: 0,
      created: 0,
      duplicate: 0,
      conflict: 0,
      skipped: 0,
    };
    counter.calls++;
    if (outcome === 'created') counter.created++;
    else if (outcome === 'duplicate_replay') counter.duplicate++;
    else if (outcome === 'conflict') counter.conflict++;
    else counter.skipped++;
  }

  setProjectEventStoragePolicy(enabled: boolean): void {
    this.eventAdmissions.skipUnsubscribedGitHubCi = enabled;
  }

  projectEventAdmissions(enabled: boolean): NonNullable<ProjectEventRecentStatus['admission']> {
    this.eventAdmissions.skipUnsubscribedGitHubCi = enabled;
    return {
      ...this.eventAdmissions,
      windowEnd: Date.now(),
      counts: structuredClone(this.eventAdmissions.counts),
    };
  }

  recordMessageIngest(batch: MessageIngestMetrics): void {
    addMessageIngestMetrics(this.messageIngest, batch);
  }

  constructor(
    private readonly projectId: () => string | null,
    private readonly afterFlush: () => void = () => {}
  ) {}

  private current(): RowUsageTotals {
    const active = context.getStore();
    const label = active?.owner === this ? active.label : 'other';
    let totals = this.totals.get(label);
    if (!totals) {
      totals = empty();
      this.totals.set(label, totals);
    }
    return totals;
  }

  /** Keep nested helper calls under their originating RPC; sections explicitly override it. */
  run<T>(label: string, work: () => T, section = false): T {
    if (!section && context.getStore()?.owner === this) return work();
    this.flush();
    return context.run({ owner: this, label }, () => {
      this.current().calls++;
      try {
        const result = work();
        if (result instanceof Promise) {
          return result.then(
            (value) => {
              this.flush();
              return value;
            },
            (error: unknown) => {
              this.flush();
              throw error;
            }
          ) as T;
        }
        return result;
      } finally {
        this.flush();
      }
    });
  }

  /**
   * Fold at the next exec/operation boundary, after the caller has consumed the statement.
   * Only one cursor is retained. Unusual cursors consumed across awaits/another exec can have
   * late reads omitted; overlapping awaited work can cross a reporting window. This is
   * diagnostic attribution, not a replacement for Cloudflare's billed counters.
   */
  fold(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.totals.rowsRead += pending.cursor.rowsRead ?? 0;
    pending.totals.rowsWritten += pending.cursor.rowsWritten ?? 0;
  }

  sql(storage: SqlStorage): SqlStorage {
    return new Proxy(storage, {
      get: (target, key) => {
        if (key === 'exec')
          return (query: string, ...bindings: unknown[]) => {
            this.fold();
            const cursor = target.exec(query, ...bindings);
            this.pending = { cursor, totals: this.current() };
            return cursor;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  storage<T extends DurableObjectStorage | DurableObjectTransaction>(storage: T): T {
    return new Proxy(storage, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        if (key === 'sql' && 'sql' in target) return this.sql(target.sql);
        if (typeof value !== 'function') return value;
        if (key === 'transaction' && 'transaction' in target)
          return (callback: (txn: DurableObjectTransaction) => Promise<unknown>) =>
            target.transaction((txn) => callback(this.storage(txn)));

        if (key === 'setAlarm' || key === 'deleteAlarm' || key === 'put' || key === 'delete') {
          return (...args: unknown[]) => {
            // Alarms have no SQL cursor; record successful alarm mutations separately.
            // SQLite-backed KV puts write one hidden-table row per key (not legacy 4 KiB units).
            let count = 1;
            if (key === 'put' && typeof args[0] === 'object' && args[0] !== null)
              count = Object.keys(args[0]).length;
            else if (key === 'delete' && Array.isArray(args[0])) count = args[0].length;
            const result = value.apply(target, args);
            const record = (deleted?: number | boolean) => {
              const totals = this.current();
              const written = key === 'delete' ? Number(deleted) : count;
              totals.rowsWritten += written;
              if (key === 'setAlarm' || key === 'deleteAlarm') totals.alarmWrites += count;
            };
            return result.then((deleted: number | boolean | undefined) => {
              record(deleted);
              return deleted;
            });
          };
        }
        return value.bind(target);
      },
    });
  }

  flush(now = Date.now()): void {
    this.fold();
    if (now - this.windowStart < this.intervalMs || this.totals.size === 0) return;
    const labels: RowUsageLabel[] = [...this.totals].map(([label, totals]) => ({
      label,
      ...totals,
    }));
    labels.sort((a, b) => b.rowsWritten - a.rowsWritten || a.label.localeCompare(b.label));
    const named = labels.filter((entry) => entry.label !== 'other');
    const dropped = named.slice(ROW_USAGE_LABEL_LIMIT);
    const other = labels.find((entry) => entry.label === 'other') ?? { label: 'other', ...empty() };
    for (const entry of dropped) {
      other.calls += entry.calls;
      other.rowsRead += entry.rowsRead;
      other.rowsWritten += entry.rowsWritten;
      other.alarmWrites += entry.alarmWrites;
    }
    const selected = named.slice(0, ROW_USAGE_LABEL_LIMIT);
    if (labels.some((entry) => entry.label === 'other') || dropped.length) selected.push(other);
    selected.sort((a, b) => b.rowsWritten - a.rowsWritten || a.label.localeCompare(b.label));
    try {
      log.info('row_usage', {
        projectId: this.projectId(),
        windowStart: this.windowStart,
        windowEnd: now,
        labels: Object.fromEntries(selected.map((entry, rank) => [`rank${rank}`, entry])),
        droppedLabelCount: dropped.length,
        totalLabelCount: labels.length,
        messageIngest: this.messageIngest,
        projectEventAdmissions: { ...this.eventAdmissions, windowEnd: now },
      });
    } catch {
      // Accounting must never change RPC return values or replace an application's error.
    }
    this.totals.clear();
    this.messageIngest = emptyMessageIngestMetrics();
    this.eventAdmissions = {
      windowStart: now,
      windowEnd: now,
      skipUnsubscribedGitHubCi: this.eventAdmissions.skipUnsubscribedGitHubCi,
      counts: {},
      overflowCalls: 0,
    };
    this.windowStart = now;
    try {
      this.afterFlush();
    } catch {
      /* Best-effort diagnostic settings refresh. */
    }
  }
}

/** Wrap only own prototype functions: no constructor, accessors, or DurableObject base APIs. */
export function instrumentRowUsage<T extends object>(
  prototype: T,
  usage: (instance: T) => RowUsage
): void {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (name === 'constructor' || typeof descriptor?.value !== 'function') continue;
    const original = descriptor.value;
    Object.defineProperty(prototype, name, {
      ...descriptor,
      value: function (this: T, ...args: unknown[]) {
        const label = name.startsWith('webSocket') ? 'webSocket' : name;
        return usage(this).run(label, () => original.apply(this, args));
      },
    });
  }
}
