// Queue behaviour, driven through the workflow entry points (runQueue, then runLease when the queue
// job lets the run through) against an in-memory GitHub deployments API.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEASE_TASK, leaseStatus, runLease, runQueue } from './staging-lease.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T08:00:00Z');
const sha = 'b'.repeat(40);
const timing = { deploy: 30, hold: 30, graceMinutes: 10, reservationMinutes: 480 };

function store(initial = []) {
  const records = [...initial]; // newest first
  let nextId = Math.max(0, ...initial.map((r) => r.id)) + 1;
  const hooks = { afterList: null };
  const api = async (method, endpoint, body) => {
    if (method === 'POST') {
      const record = { ...structuredClone(body), id: nextId++ };
      records.unshift(record);
      return record;
    }
    if (endpoint.startsWith('/deployments?')) {
      const query = new URLSearchParams(endpoint.split('?')[1]);
      assert.equal(query.get('task'), LEASE_TASK);
      const list = records
        .filter((r) => r.environment === query.get('environment') && r.task === LEASE_TASK)
        .slice(0, Number(query.get('per_page')))
        .map((r) => structuredClone(r));
      const hook = hooks.afterList;
      hooks.afterList = null;
      if (hook) await hook();
      return list;
    }
    return structuredClone(records.find((r) => endpoint === `/deployments/${r.id}`));
  };
  return { records, api, hooks };
}

// One workflow dispatch: queue job, then the serialized lease job if it was let through.
async function dispatch(db, branch, action, at, extra = {}) {
  const request = {
    api: db.api,
    environment: 'staging2',
    branch,
    sha,
    taskId: `task-${branch}`,
    action,
    timing,
    now: at,
    ...extra,
  };
  const queued = await runQueue(request);
  if (!queued.proceed) return { queued, refused: queued.refused };
  try {
    return { queued, lease: await runLease(request) };
  } catch (error) {
    return { queued, refused: true, error: error.message };
  }
}

const status = (db, at) => leaseStatus({ api: db.api, environment: 'staging2', now: at });
const order = async (db, at) => (await status(db, at)).queue.map((entry) => entry.branch);
const holder = async (db, at) => (await status(db, at)).holder?.branch ?? null;

test('empty queue: the first dispatch reserves and takes the slot in one run', async () => {
  const db = store();
  const { lease } = await dispatch(db, 'a', 'deploy', T0);
  assert.equal(lease.holder.branch, 'a');
  assert.equal(lease.holder.expiresAt, new Date(T0 + 60 * MIN).toISOString());
  assert.equal(await holder(db, T0 + MIN), 'a');
  assert.deepEqual(await order(db, T0 + MIN), []);
  const kinds = db.records.map((r) => r.payload.kind);
  assert.deepEqual(kinds, ['snapshot', 'reservation']);
  // Every record carries version 2, which workflow copies from before the queue refuse.
  assert.ok(db.records.every((r) => r.payload.version === 2 && r.payload.notice));
});

test('two waiters are served in order; nobody else may take a freed slot during their turns', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  const b = await dispatch(db, 'b', 'deploy', T0 + MIN);
  assert.equal(b.refused, true);
  assert.match(b.queued.lines.at(-1), /b is number 1/);
  await dispatch(db, 'c', 'reserve', T0 + 2 * MIN);
  assert.deepEqual(await order(db, T0 + 3 * MIN), ['b', 'c']);

  // A's lease expires at T0+60. Only B may take it, then only C.
  const expiry = T0 + 60 * MIN;
  for (const branch of ['c', 'd']) {
    const early = await dispatch(db, branch, 'acquire', expiry + MIN);
    assert.equal(early.refused, true, `${branch} must wait for b`);
  }
  assert.equal(await holder(db, expiry + MIN), null);
  assert.equal((await dispatch(db, 'b', 'acquire', expiry + 2 * MIN)).lease.holder.branch, 'b');
  assert.deepEqual(await order(db, expiry + 3 * MIN), ['c', 'd']);
  await dispatch(db, 'b', 'release', expiry + 5 * MIN);
  assert.equal((await dispatch(db, 'd', 'deploy', expiry + 6 * MIN)).refused, true);
  assert.equal((await dispatch(db, 'c', 'deploy', expiry + 6 * MIN)).lease.holder.branch, 'c');
  assert.deepEqual(await order(db, expiry + 7 * MIN), ['d']);
});

test('a head that misses its grace period is dropped and the next entry gets a full grace period', async () => {
  const db = store();
  await dispatch(db, 'a', 'acquire', T0, { timing: { ...timing, hold: 30 } });
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  await dispatch(db, 'c', 'reserve', T0 + 2 * MIN);
  const expiry = T0 + 30 * MIN;
  const view = await status(db, expiry + MIN);
  assert.equal(view.queue[0].turnEnds, new Date(expiry + 10 * MIN).toISOString());
  assert.equal(view.queue[1].turnStarts, new Date(expiry + 10 * MIN).toISOString());
  // B never comes. At expiry+10 the turn passes to C until expiry+20.
  assert.equal((await dispatch(db, 'c', 'acquire', expiry + 9 * MIN)).refused, true);
  assert.equal((await dispatch(db, 'd', 'acquire', expiry + 12 * MIN)).refused, true);
  assert.equal((await dispatch(db, 'c', 'acquire', expiry + 19 * MIN)).lease.holder.branch, 'c');
  // B wakes late: it is behind D now.
  assert.equal((await dispatch(db, 'b', 'deploy', expiry + 25 * MIN)).refused, true);
  assert.deepEqual(await order(db, expiry + 26 * MIN), ['d', 'b']);
});

test('a missed head that reserves again rejoins at the back, even before the snapshot is rewritten', async () => {
  const db = store();
  await dispatch(db, 'a', 'acquire', T0);
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  await dispatch(db, 'c', 'reserve', T0 + 2 * MIN);
  const expiry = T0 + 30 * MIN;
  await dispatch(db, 'b', 'reserve', expiry + 15 * MIN); // missed [expiry, expiry+10)
  assert.deepEqual(await order(db, expiry + 15 * MIN), ['c', 'b']);
});

test('a holder that releases goes behind everyone already queued', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  const released = await dispatch(db, 'a', 'release', T0 + 20 * MIN);
  assert.match(released.lease.message, /released by a/);
  const again = await dispatch(db, 'a', 'deploy', T0 + 21 * MIN);
  assert.equal(again.refused, true);
  assert.deepEqual(await order(db, T0 + 21 * MIN), ['b', 'a']);
  // Early release never shortens B's turn: it lasts until A's announced expiry plus grace.
  const view = await status(db, T0 + 21 * MIN);
  assert.equal(view.queue[0].turnEnds, new Date(T0 + 70 * MIN).toISOString());
  assert.equal((await dispatch(db, 'b', 'acquire', T0 + 65 * MIN)).lease.holder.branch, 'b');
});

test('the branch whose turn it is can leave the queue, and the next one may start at once', async () => {
  const db = store();
  await dispatch(db, 'a', 'acquire', T0);
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  await dispatch(db, 'c', 'reserve', T0 + MIN);
  const expiry = T0 + 30 * MIN;
  await dispatch(db, 'b', 'release', expiry + 2 * MIN);
  assert.deepEqual(await order(db, expiry + 2 * MIN), ['c']);
  const view = await status(db, expiry + 2 * MIN);
  assert.equal(view.queue[0].status, 'turn');
  assert.equal(view.queue[0].turnEnds, new Date(expiry + 20 * MIN).toISOString());
  // A releasing branch that holds nothing writes nothing.
  const before = db.records.length;
  assert.equal((await dispatch(db, 'z', 'release', expiry + 3 * MIN)).lease.written, false);
  assert.equal(db.records.length, before);
  // Someone else's lease cannot be released.
  await dispatch(db, 'c', 'acquire', expiry + 3 * MIN);
  assert.match(
    (await dispatch(db, 'z', 'release', expiry + 4 * MIN)).error,
    /Only holder branch c/
  );
});

test('stale reservations expire and take no turn', async () => {
  const db = store();
  const short = { ...timing, reservationMinutes: 45 };
  await dispatch(db, 'a', 'deploy', T0); // expires T0+60
  await dispatch(db, 'b', 'reserve', T0 + MIN, { timing: short }); // reservation expires T0+46
  assert.deepEqual(await order(db, T0 + 2 * MIN), []);
  assert.equal((await dispatch(db, 'c', 'deploy', T0 + 61 * MIN)).lease.holder.branch, 'c');
  // Reserving again renews a reservation without losing the place.
  const db2 = store();
  await dispatch(db2, 'a', 'deploy', T0);
  await dispatch(db2, 'b', 'reserve', T0 + MIN, { timing: short });
  await dispatch(db2, 'c', 'reserve', T0 + 2 * MIN);
  await dispatch(db2, 'b', 'reserve', T0 + 40 * MIN);
  assert.deepEqual(await order(db2, T0 + 41 * MIN), ['b', 'c']);
  assert.equal((await dispatch(db2, 'b', 'acquire', T0 + 61 * MIN)).lease.holder.branch, 'b');
});

test('concurrent reservations, including one made while the lease job writes, all keep their place', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  // B and C reserve "at once": both append, ordered by record id.
  await Promise.all([
    dispatch(db, 'b', 'reserve', T0 + MIN),
    dispatch(db, 'c', 'reserve', T0 + MIN),
  ]);
  // D reserves between the lease job's read and its snapshot write.
  db.hooks.afterList = () =>
    runQueue({
      api: db.api,
      environment: 'staging2',
      branch: 'd',
      sha,
      action: 'reserve',
      timing,
      now: T0 + 2 * MIN,
    });
  await runLease({
    api: db.api,
    environment: 'staging2',
    branch: 'a',
    sha,
    action: 'deploy',
    timing,
    now: T0 + 2 * MIN,
  });
  const snapshot = db.records.find((r) => r.payload.kind === 'snapshot');
  assert.ok(!snapshot.payload.queue.some((entry) => entry.branch === 'd'));
  assert.deepEqual(await order(db, T0 + 3 * MIN), ['b', 'c', 'd']);
});

test('a version 1 record from an older workflow is honoured as the holder, and the queue forms behind it', async () => {
  const legacy = {
    id: 7,
    task: LEASE_TASK,
    environment: 'staging2',
    payload: {
      version: 1,
      environment: 'staging2',
      state: 'held',
      branch: 'old',
      sha,
      taskId: 'task-old',
      expiresAt: new Date(T0 + 30 * MIN).toISOString(),
    },
  };
  const db = store([legacy]);
  assert.equal(await holder(db, T0), 'old');
  assert.equal((await dispatch(db, 'b', 'deploy', T0)).refused, true);
  assert.equal((await dispatch(db, 'c', 'deploy', T0 + 31 * MIN)).refused, true);
  assert.equal((await dispatch(db, 'b', 'deploy', T0 + 32 * MIN)).lease.holder.branch, 'b');
  const released = store([
    {
      ...legacy,
      payload: { ...legacy.payload, state: 'released', expiresAt: new Date(T0).toISOString() },
    },
  ]);
  assert.equal((await dispatch(released, 'c', 'deploy', T0 + MIN)).lease.holder.branch, 'c');
});

// The guard from workflow copies before the queue (#2762, #2766), verbatim in effect: they read
// only the newest record and refuse it unless it is a valid version 1 lease.
function olderWorkflowReads(records) {
  const lease = records[0]?.payload;
  if (lease && lease.version !== 1) throw new Error('Malformed lease record');
  return lease;
}

test('older workflow copies are refused on every record the queue writes, so they cannot jump it', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  assert.throws(() => olderWorkflowReads(db.records), /Malformed/);
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  assert.throws(() => olderWorkflowReads(db.records), /Malformed/);
  await dispatch(db, 'a', 'release', T0 + 2 * MIN);
  assert.throws(() => olderWorkflowReads(db.records), /Malformed/);
});

test('malformed records: snapshots and unknown versions fail closed, bad reservations are skipped', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  const good = store(structuredClone(db.records));
  const snapshot = db.records[0];
  for (const payload of [
    '{bad json',
    null,
    { ...snapshot.payload, holder: { branch: 'x' } },
    { ...snapshot.payload, queue: 'nope' },
    { ...snapshot.payload, seenThrough: snapshot.id },
    { ...snapshot.payload, version: 3 },
    { ...snapshot.payload, kind: 'other' },
  ]) {
    const bad = store([{ ...snapshot, payload }, ...db.records.slice(1)]);
    const before = bad.records.length;
    const result = await dispatch(bad, 'b', 'deploy', T0 + 90 * MIN).catch((error) => ({ error }));
    assert.match(String(result.error?.message ?? result.error), /Malformed/);
    assert.equal(bad.records.length, before, 'nothing written');
  }
  good.records.unshift({
    id: 99,
    task: LEASE_TASK,
    environment: 'staging2',
    payload: { version: 2, kind: 'reservation', environment: 'staging2', branch: '' },
  });
  await dispatch(good, 'c', 'reserve', T0 + MIN);
  const view = await status(good, T0 + 2 * MIN);
  assert.deepEqual(
    view.queue.map((entry) => entry.branch),
    ['c']
  );
  assert.match(view.warnings[0], /Skipped malformed reservation record 99/);
});

test('history that does not fit in one page fails closed', async () => {
  const records = Array.from({ length: 100 }, (_, index) => ({
    id: 200 - index,
    task: LEASE_TASK,
    environment: 'staging2',
    payload: {
      version: 2,
      kind: 'reservation',
      environment: 'staging2',
      branch: `b${index}`,
      taskId: '',
      reservedAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 60 * MIN).toISOString(),
    },
  }));
  await assert.rejects(status(store(records), T0), /does not fit/);
});

test('installations are independent', async () => {
  const db = store();
  await dispatch(db, 'a', 'deploy', T0);
  const other = await runQueue({
    api: db.api,
    environment: 'staging',
    branch: 'b',
    sha,
    action: 'deploy',
    timing,
    now: T0,
  });
  assert.equal(other.proceed, true);
});

test('the serialized lease job re-decides: a run let through by a stale queue read is still refused', async () => {
  const db = store();
  await dispatch(db, 'a', 'acquire', T0);
  await dispatch(db, 'b', 'reserve', T0 + MIN);
  const expiry = T0 + 30 * MIN;
  const request = {
    api: db.api,
    environment: 'staging2',
    sha,
    action: 'acquire',
    timing,
    now: expiry + MIN,
  };
  await assert.rejects(runLease({ ...request, branch: 'c' }), /reserved for b/);
  await assert.rejects(runLease({ ...request, branch: 'a' }), /reserved for b/);
  assert.equal((await runLease({ ...request, branch: 'b' })).holder.branch, 'b');
});

test('a reservation by the branch that takes the slot meanwhile does not queue it behind itself', async () => {
  const db = store();
  await runQueue({
    api: db.api,
    environment: 'staging2',
    branch: 'b',
    sha,
    action: 'deploy',
    timing,
    now: T0,
  });
  db.hooks.afterList = () =>
    runQueue({
      api: db.api,
      environment: 'staging2',
      branch: 'b',
      sha,
      action: 'reserve',
      timing,
      now: T0,
    });
  await runLease({
    api: db.api,
    environment: 'staging2',
    branch: 'b',
    sha,
    action: 'deploy',
    timing,
    now: T0,
  });
  assert.equal(await holder(db, T0 + MIN), 'b');
  assert.deepEqual(await order(db, T0 + MIN), []);
});
