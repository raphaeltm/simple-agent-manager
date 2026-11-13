/**
 * Drives the Worker's key-rotation control endpoint (apps/api/src/selfhost/key-rotation/) for
 * `rotate`: one bounded page per request, the cursor and counts saved to the journal after every
 * page, so an interrupted pass resumes at the last saved cursor. A page that is replayed after a
 * crash is harmless: migrate re-reads each row and skips what is already under the current key.
 *
 * Throughput (rules/81): a D1 page is up to 200 rows or 10 s; each row costs two AES-GCM
 * operations (microseconds) and, when re-encrypted, one D1 batch of 1-3 statements. On celld's
 * local SQLite that is ~1-5 ms per row, so ~200-1000 rows/s. A large install (100k encrypted
 * values) takes ~2-8 minutes; the loop has no row cap, only the per-page time budget. Library
 * files cost a head, a get and a put of the body each (25 per page): bandwidth-bound on the box's
 * object store, e.g. 10k files of 1 MB in ~5-15 minutes. Nothing is unreadable meanwhile.
 */
import type { RowRef, StepState } from './rotate-store';

export type DataTarget =
  | { target: 'd1'; location: string; label: string }
  | { target: 'library'; label: string }
  | { target: 'better-auth'; label: string };

export type ControlCall = (body: Record<string, unknown>) => Promise<unknown>;

/** Samples kept in the journal; counts are always exact. */
const MAX_KEPT_ROWS = 500;

interface PageResult {
  nextCursor: string | null;
  done: boolean;
  current: number;
  migrated: number;
  previous: number;
  unreadable: number;
  unreadableRows: RowRef[];
  previousRows: RowRef[];
}

function parsePage(value: unknown): PageResult {
  const record =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const count = (name: string) => {
    const n = record[name];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new Error(`key-rotation endpoint answered without a valid ${name}`);
    }
    return n;
  };
  const rows = (name: string): RowRef[] =>
    Array.isArray(record[name])
      ? (record[name] as unknown[]).filter(
          (r): r is RowRef =>
            typeof r === 'object' && r !== null && typeof (r as RowRef).id === 'string'
        )
      : [];
  if (typeof record.done !== 'boolean')
    throw new Error('key-rotation endpoint answered without done');
  const cursor = record.nextCursor;
  return {
    nextCursor: typeof cursor === 'string' ? cursor : null,
    done: record.done,
    current: count('current'),
    migrated: count('migrated'),
    previous: count('previous'),
    unreadable: count('unreadable'),
    unreadableRows: rows('unreadableRows'),
    previousRows: rows('previousRows'),
  };
}

/** The data targets a rotation covers, from the Worker's own view of which roles rotate. */
export async function rotationTargets(
  call: ControlCall,
  kind: 'aes' | 'better-auth'
): Promise<DataTarget[]> {
  if (kind === 'better-auth') return [{ target: 'better-auth', label: 'accounts' }];
  const status = (await call({ op: 'status' })) as {
    roles?: Record<string, boolean>;
    locations?: string[];
  };
  const roles = status.roles ?? {};
  if (!Object.values(roles).some(Boolean)) {
    throw new Error(
      'the Worker reports no AES key rotating: the transitional bundle is not deployed'
    );
  }
  // Which D1 locations use which role is the Worker's registry; it reports the rotating roles,
  // and a location whose role is not rotating answers every value as current (cheap no-op).
  const locations = (status.locations ?? []).filter(
    (name) => name !== 'library_files' && name !== 'accounts'
  );
  const targets: DataTarget[] = locations.map((location) => ({
    target: 'd1',
    location,
    label: location,
  }));
  if (roles.library) targets.push({ target: 'library', label: 'library_files' });
  return targets;
}

export interface PassTotals {
  current: number;
  migrated: number;
  previous: number;
  unreadable: number;
  unreadableRows: RowRef[];
  previousRows: RowRef[];
}

/**
 * Runs `mode` over every target, resuming from the step's saved cursors when `label` names the
 * pass already recorded (an interrupted run), else starting it fresh. `save` persists the
 * journal; it is called after every page.
 */
export async function runPass(
  step: StepState,
  label: string,
  targets: readonly DataTarget[],
  mode: 'migrate' | 'verify',
  call: ControlCall,
  save: () => void,
  log: (message: string) => void
): Promise<PassTotals> {
  if (step.pass !== label) {
    step.pass = label;
    step.cursors = {};
    step.finishedLocations = [];
    step.counts = { current: 0, migrated: 0, previous: 0, unreadable: 0 };
    step.unreadableRows = [];
    delete step.previousRows;
    save();
  }
  const counts = step.counts ?? { current: 0, migrated: 0, previous: 0, unreadable: 0 };
  step.counts = counts;
  const cursors = step.cursors ?? {};
  step.cursors = cursors;
  const finished = step.finishedLocations ?? [];
  step.finishedLocations = finished;
  const unreadableRows = step.unreadableRows ?? [];
  step.unreadableRows = unreadableRows;
  const previousRows = step.previousRows ?? [];
  step.previousRows = previousRows;
  for (const target of targets) {
    if (finished.includes(target.label)) continue;
    let pages = 0;
    for (;;) {
      const page = parsePage(
        await call({
          op: 'pass',
          target: target.target,
          ...(target.target === 'd1' ? { location: target.location } : {}),
          mode,
          cursor: cursors[target.label] ?? null,
        })
      );
      pages += 1;
      counts.current += page.current;
      counts.migrated += page.migrated;
      counts.previous += page.previous;
      counts.unreadable += page.unreadable;
      for (const row of page.unreadableRows) {
        if (unreadableRows.length < MAX_KEPT_ROWS) unreadableRows.push(row);
      }
      for (const row of page.previousRows) {
        if (previousRows.length < MAX_KEPT_ROWS) previousRows.push(row);
      }
      cursors[target.label] = page.nextCursor;
      if (page.done) finished.push(target.label);
      save();
      if (page.done) break;
    }
    log(`  ${mode} ${target.label}: done (${pages} page${pages === 1 ? '' : 's'})`);
  }
  return { ...counts, unreadableRows, previousRows };
}
