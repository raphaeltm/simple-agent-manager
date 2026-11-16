// Pure state and decisions for the staging verification lease and its queue.
// I/O and the workflow entry points live in staging-lease.mjs.
//
// Records are GitHub deployments with task `staging-lease`, one stream per installation.
// - kind "reservation" (version 2): an append-only queue event. Written outside the workflow's
//   concurrency group, so a pending-run cancellation can never lose it.
// - kind "snapshot" (version 2): the whole state (holder, ordered queue). Written only by the
//   serialized lease job. `seenThrough` is the highest record id that job had read.
// - version 1: the pre-queue lease shape (#2762). Read as a base state; never written.
// State = newest snapshot (or version 1 record) + reservation events with id > seenThrough.
// Workflow copies from before the queue read only the newest record and refuse anything that is
// not version 1, so they can neither jump the queue nor drop it.

export const LEASE_TASK = 'staging-lease';
export const RECORD_PAGE_SIZE = 100;
// Pages read before giving up. Only reservations accumulate between snapshots, so 500 records
// is far beyond any realistic queue; past it every call fails closed.
export const RECORD_MAX_PAGES = 5;
export const OLD_WORKFLOW_NOTICE =
  'Staging lease queue (version 2). Update this branch from origin/main to reserve, deploy or release; workflow copies from before the queue refuse this record by design.';

const MINUTE = 60_000;
const SHA = /^[a-f0-9]{40}$/i;

export function validUtc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  const canonical = value.length === 20 ? value.replace('Z', '.000Z') : value;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical;
}

const iso = (ms) => new Date(ms).toISOString();
const text = (value) => typeof value === 'string';
const branchName = (value) => text(value) && value.length > 0;
const utcOrNull = (value) => value === null || validUtc(value);

function malformed(id, detail) {
  return new Error(
    `Malformed lease record ${id ?? '(no id)'} (${detail}); refusing to change the lease. Inspect the record with gh api.`
  );
}

function validEntry(entry) {
  return (
    branchName(entry?.branch) &&
    text(entry.taskId) &&
    validUtc(entry.reservedAt) &&
    validUtc(entry.expiresAt) &&
    (entry.lastReservedAt === undefined || validUtc(entry.lastReservedAt))
  );
}

function validHolder(holder) {
  return (
    holder === null ||
    (branchName(holder?.branch) &&
      text(holder.taskId) &&
      SHA.test(holder.sha ?? '') &&
      validUtc(holder.acquiredAt) &&
      validUtc(holder.expiresAt))
  );
}

// Classify one deployment record. Throws (fail closed) for anything that could be the authoritative
// state and does not validate, and for unknown versions or kinds. A malformed reservation event is
// returned as `invalid`: it can only ever add a queue entry, so skipping it cannot hand anyone the slot.
export function parseRecord(record, environment) {
  const id = record?.id;
  if (!Number.isSafeInteger(id) || id < 1) throw malformed(id, 'missing id');
  let payload = record.payload;
  if (text(payload)) {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw malformed(id, 'payload is not JSON');
    }
  }
  if (record.environment !== environment || record.task !== LEASE_TASK || !payload)
    throw malformed(id, 'wrong environment or task');
  if (payload.environment !== environment) throw malformed(id, 'payload environment');
  if (payload.version === 1) {
    if (
      !['held', 'released'].includes(payload.state) ||
      !branchName(payload.branch) ||
      !SHA.test(payload.sha ?? '') ||
      !text(payload.taskId) ||
      !validUtc(payload.expiresAt)
    )
      throw malformed(id, 'version 1 fields');
    return { type: 'legacy', id, lease: payload };
  }
  if (payload.version !== 2) throw malformed(id, `unknown version ${payload.version}`);
  if (payload.kind === 'reservation') {
    if (!validEntry(payload)) return { type: 'invalid', id, reason: 'reservation fields' };
    const { branch, taskId, reservedAt, expiresAt } = payload;
    return { type: 'reservation', id, entry: { branch, taskId, reservedAt, expiresAt } };
  }
  if (payload.kind !== 'snapshot') throw malformed(id, `unknown kind ${payload.kind}`);
  const queue = payload.queue;
  if (
    !Number.isSafeInteger(payload.seenThrough) ||
    payload.seenThrough < 0 ||
    payload.seenThrough >= id ||
    !validHolder(payload.holder) ||
    !utcOrNull(payload.freeSince) ||
    !utcOrNull(payload.promisedAt) ||
    !Array.isArray(queue) ||
    !queue.every(validEntry) ||
    new Set(queue.map((entry) => entry.branch)).size !== queue.length
  )
    throw malformed(id, 'snapshot fields');
  return {
    type: 'snapshot',
    id,
    state: {
      holder: payload.holder,
      freeSince: payload.freeSince,
      promisedAt: payload.promisedAt,
      queue: queue.map((entry) => ({ ...entry })),
      seenThrough: payload.seenThrough,
    },
  };
}

function baseState(parsed) {
  if (!parsed)
    return { holder: null, freeSince: null, promisedAt: null, queue: [], seenThrough: 0 };
  if (parsed.type === 'snapshot') return parsed.state;
  const { lease } = parsed;
  const held = lease.state === 'held';
  return {
    holder: held
      ? {
          branch: lease.branch,
          taskId: lease.taskId,
          sha: lease.sha,
          acquiredAt: lease.expiresAt,
          expiresAt: lease.expiresAt,
        }
      : null,
    freeSince: held ? null : lease.expiresAt,
    promisedAt: held ? null : lease.expiresAt,
    queue: [],
    seenThrough: parsed.id,
  };
}

// A reservation by a branch already queued keeps its place and extends its expiry. It also records
// when it was made, so a branch that missed its turn and reserves again rejoins at the back.
export function applyReservation(state, entry) {
  // Only a live hold makes the reservation redundant; a holder whose lease ran out queues again.
  const holder = state.holder;
  if (
    holder?.branch === entry.branch &&
    Date.parse(holder.expiresAt) > Date.parse(entry.reservedAt)
  )
    return;
  const existing = state.queue.find((queued) => queued.branch === entry.branch);
  if (!existing) {
    state.queue.push({ ...entry });
    return;
  }
  if (Date.parse(entry.expiresAt) > Date.parse(existing.expiresAt))
    existing.expiresAt = entry.expiresAt;
  if (Date.parse(entry.reservedAt) > Date.parse(existing.lastReservedAt ?? existing.reservedAt))
    existing.lastReservedAt = entry.reservedAt;
  if (entry.taskId) existing.taskId = entry.taskId;
}

// records: newest first, as GitHub lists deployments. `complete` is true when they are the whole
// history. Throws an error with `incomplete: true` when more history is needed.
//
// Known limit: a reservation becomes visible to everyone at once in id order is assumed. If
// GitHub listed a newer record before an older one created within the same milliseconds, a
// snapshot's seenThrough could pass the older one before it was visible, and it would be skipped.
// The lease job lists seconds after its own queue job wrote, which bounds this to reservations
// created in the instant the lease job reads; the affected agent sees itself missing in `status`.
export function foldRecords(records, environment, complete = false) {
  if (!Array.isArray(records)) throw new Error('Unreadable deployment list; refusing lease change');
  const events = [];
  const warnings = [];
  let base = null;
  let covered = complete;
  for (const record of records) {
    const parsed = parseRecord(record, environment);
    if (base) {
      if (parsed.id <= base.state.seenThrough) {
        covered = true;
        break;
      }
      // Older than the snapshot but unseen by it: a reservation made while it was being written.
      if (parsed.type === 'reservation' || parsed.type === 'invalid') events.push(parsed);
      else warnings.push(`Ignored lease record ${parsed.id} written while snapshot ${base.id} was`);
      continue;
    }
    if (parsed.type === 'reservation' || parsed.type === 'invalid') {
      events.push(parsed);
      continue;
    }
    base = { id: parsed.id, state: baseState(parsed) };
    if (base.state.seenThrough >= parsed.id - 1) {
      covered = true;
      break;
    }
  }
  if (!covered) {
    const error = new Error(
      `Lease history does not fit in the newest ${records.length} records; refusing lease change`
    );
    error.incomplete = true;
    throw error;
  }
  const state = base ? base.state : baseState(null);
  for (const event of events.sort((a, b) => a.id - b.id)) {
    if (event.id <= state.seenThrough) continue;
    if (event.type === 'invalid') {
      warnings.push(`Skipped malformed reservation record ${event.id} (${event.reason})`);
      continue;
    }
    applyReservation(state, event.entry);
  }
  state.seenThrough = records.reduce((max, record) => Math.max(max, record.id), state.seenThrough);
  return { state, warnings };
}

// Work out, at `now`, who holds the slot and every queued branch's turn window.
// While the slot is free, the first live entry may take it from max(freeSince, reservedAt) until
// max(that, promisedAt) + grace; promisedAt is the expiry the last holder had announced, so an
// early release never shortens the waiter's turn. Each later entry gets `grace` after the one
// before it. An entry whose reservation expires before its turn starts is stale and takes no time.
export function resolveTurns(state, now, graceMinutes) {
  const grace = graceMinutes * MINUTE;
  let holder = state.holder;
  let lastHolder = null;
  let freeSince = state.freeSince ? Date.parse(state.freeSince) : 0;
  let promisedAt = state.promisedAt ? Date.parse(state.promisedAt) : freeSince;
  if (holder && Date.parse(holder.expiresAt) <= now) {
    lastHolder = holder;
    freeSince = promisedAt = Date.parse(holder.expiresAt);
    holder = null;
  }
  if (holder) freeSince = promisedAt = Date.parse(holder.expiresAt); // estimate only
  const pending = state.queue.map((entry) => ({ ...entry }));
  const entries = [];
  let previousEnd = null;
  for (let index = 0; index < pending.length; index += 1) {
    const entry = pending[index];
    const reserved = Date.parse(entry.reservedAt);
    const first = previousEnd === null;
    const start = first ? Math.max(freeSince, reserved) : Math.max(previousEnd, reserved);
    if (Date.parse(entry.expiresAt) <= start) {
      entries.push({ ...entry, status: 'stale', start, end: start });
      continue;
    }
    const end = (first ? Math.max(start, promisedAt) : start) + grace;
    let status = 'waiting';
    if (!holder && end <= now) status = 'missed';
    else if (!holder && start <= now) status = 'turn';
    entries.push({ ...entry, status, start, end });
    previousEnd = end;
    const again = entry.lastReservedAt ? Date.parse(entry.lastReservedAt) : null;
    if (status === 'missed' && again !== null && again >= end) {
      // Missed its turn, then reserved again: back of the queue.
      pending.push({
        branch: entry.branch,
        taskId: entry.taskId,
        reservedAt: entry.lastReservedAt,
        expiresAt: entry.expiresAt,
      });
    }
  }
  const live = entries.filter((entry) => entry.status === 'turn' || entry.status === 'waiting');
  return { holder, lastHolder, freeSince, promisedAt, entries, live, grace };
}

function queueEntry({ branch, taskId, reservedAt, expiresAt, lastReservedAt }) {
  return lastReservedAt
    ? { branch, taskId, reservedAt, expiresAt, lastReservedAt }
    : { branch, taskId, reservedAt, expiresAt };
}

// The state to store after a decision taken while the slot is free. Dropped (missed or stale)
// entries are removed, and freeSince/promisedAt are moved so the remaining windows are unchanged.
// If the branch whose turn it was leaves, the next one may start at once and still keeps the window
// it was promised.
function freeSnapshot(turns, keep, now) {
  const remaining = turns.live.filter(keep);
  if (remaining.length === 0)
    return {
      holder: null,
      freeSince: iso(turns.freeSince),
      promisedAt: iso(turns.promisedAt),
      queue: [],
    };
  const [first] = remaining;
  return {
    holder: null,
    freeSince: iso(Math.min(first.start, now)),
    promisedAt: iso(first.end - turns.grace),
    queue: remaining.map(queueEntry),
  };
}

// The queue job saw the branch's turn at `checkedAt` and let the run through; waiting for a runner
// or for the concurrency group must not cost it the turn. Bounded to a few grace periods back.
function hadTurn(state, branch, checkedAt, now, graceMinutes) {
  const checked = checkedAt ? Date.parse(checkedAt) : NaN;
  if (!Number.isFinite(checked) || checked > now || checked < now - 3 * graceMinutes * MINUTE)
    return false;
  return hasTurn(resolveTurns(state, checked, graceMinutes), branch);
}

export function hasTurn(turns, branch) {
  return !turns.holder && turns.live[0]?.branch === branch && turns.live[0].status === 'turn';
}

export function position(turns, branch) {
  const index = turns.live.findIndex((entry) => entry.branch === branch);
  return index === -1 ? null : index + 1;
}

export function describeTurn(entry) {
  return `${entry.branch} (SAM task ${entry.taskId || 'not supplied'}) ${entry.status === 'turn' ? 'may take the slot until' : 'turn from'} ${iso(entry.status === 'turn' ? entry.end : entry.start)}`;
}

function refusal(turns, branch, environment) {
  const where = position(turns, branch);
  const place = where
    ? `You are number ${where} in the queue; your turn is estimated to start at ${iso(turns.live[where - 1].start)}. Schedule a wake for it.`
    : 'You are not in the queue.';
  if (turns.holder)
    return `Environment ${environment} held by branch ${turns.holder.branch}, SAM task ${turns.holder.taskId || '(not supplied)'}, expires ${turns.holder.expiresAt}. ${place}`;
  return `Environment ${environment} is reserved for ${describeTurn(turns.live[0])}. ${place}`;
}

// Queue phase (outside the concurrency group): should this run append a reservation? `reserve`
// always appends (renewing it); deploy/acquire append unless the branch holds the lease or waits.
export function planQueue({ state, branch, action, now, graceMinutes }) {
  const turns = resolveTurns(state, now, graceMinutes);
  const holds = turns.holder?.branch === branch;
  if (action === 'release' || holds) return { append: false, holds, turns };
  return { append: action === 'reserve' || position(turns, branch) === null, holds, turns };
}

// Lease phase (serialized): the authoritative decision. Returns the snapshot state to write, or
// null when nothing changes. Throws a refusal message when the branch may not proceed.
export function decideLease({
  state,
  branch,
  taskId,
  sha,
  action,
  now,
  graceMinutes,
  holdMinutes,
  environment,
  turnCheckedAt = null,
}) {
  if (!['deploy', 'acquire', 'release'].includes(action)) throw new Error('Unknown lease action');
  const turns = resolveTurns(state, now, graceMinutes);
  const mine = (entry) => entry.branch === branch;
  if (action === 'release') {
    if (turns.holder && mine(turns.holder)) {
      return {
        holder: null,
        freeSince: iso(now),
        promisedAt: turns.holder.expiresAt,
        queue: state.queue.filter((entry) => !mine(entry)).map(queueEntry),
      };
    }
    if (!state.queue.some(mine)) {
      if (turns.holder)
        throw new Error(`Only holder branch ${turns.holder.branch} may release this lease.`);
      return null; // Nothing held or queued by this branch: releasing is a no-op.
    }
    if (turns.holder)
      return { ...state, queue: state.queue.filter((entry) => !mine(entry)).map(queueEntry) };
    return freeSnapshot(turns, (entry) => !mine(entry), now);
  }
  const expiresAt = iso(now + holdMinutes * MINUTE);
  if (turns.holder) {
    if (!mine(turns.holder)) throw new Error(refusal(turns, branch, environment));
    return {
      ...state,
      holder: { ...turns.holder, sha, taskId: taskId || turns.holder.taskId, expiresAt },
    };
  }
  if (
    turns.live.length > 0 &&
    !hasTurn(turns, branch) &&
    !hadTurn(state, branch, turnCheckedAt, now, graceMinutes)
  )
    throw new Error(refusal(turns, branch, environment));
  return {
    holder: { branch, taskId, sha, acquiredAt: iso(now), expiresAt },
    freeSince: null,
    promisedAt: null,
    queue: turns.live.filter((entry) => !mine(entry)).map(queueEntry),
  };
}
