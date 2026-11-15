import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLease, leaseTiming, readLease, runLease, LEASE_TASK } from './staging-lease.mjs';

const now = Date.parse('2026-11-15T19:00:00Z');
const sha = 'a'.repeat(40);
const held = {
  version: 1,
  state: 'held',
  environment: 'staging',
  branch: 'holder',
  sha,
  taskId: 'task-1',
  expiresAt: '2026-11-15T20:00:00Z',
};
const record = (payload = held) => ({
  id: 1,
  task: LEASE_TASK,
  environment: held.environment,
  payload,
});
const decide = (lease, branch = 'other', action = 'deploy') =>
  decideLease({ lease, branch, now, action });

test('missing records bootstrap free; active foreign holders fail with owner, task and expiry', () => {
  assert.equal(readLease(undefined, 'staging'), null);
  assert.equal(decide(null), 'held');
  assert.throws(() => decide(held), /holder, SAM task task-1, expires 2026-11-15T20:00:00Z/);
});

test('expired foreign lease (including exact expiry) and same-branch lease permit acquisition', () => {
  assert.equal(decide({ ...held, expiresAt: new Date(now).toISOString() }), 'held');
  assert.equal(decide({ ...held, expiresAt: new Date(now - 1).toISOString() }), 'held');
  assert.equal(decide(held, 'holder'), 'held');
  assert.equal(decide({ ...held, state: 'released' }), 'held');
});

test('only holder releases, expiry permits acquisition rather than foreign release', () => {
  assert.equal(decide(held, 'holder', 'release'), 'released');
  assert.throws(() => decide(held, 'other', 'release'), /held by branch holder/);
  assert.throws(
    () => decide({ ...held, expiresAt: new Date(now).toISOString() }, 'other', 'release'),
    /Only holder/
  );
});

test('malformed records fail closed, including malformed expired and self-held records', () => {
  for (const payload of [
    null,
    {},
    '{bad json',
    { ...held, expiresAt: 'bad' },
    { ...held, sha: '' },
    { ...held, version: 2 },
    { ...held, environment: 'second' },
  ]) {
    assert.throws(() => readLease(record(payload), 'staging'), /Malformed/);
  }
  assert.deepEqual(readLease(record(JSON.stringify(held)), 'staging'), held);
});

test('hold defaults and cap are configurable; unsafe or noninteger durations rejected', () => {
  assert.deepEqual(leaseTiming({}), { hold: 30, deploy: 30 });
  assert.deepEqual(
    leaseTiming({
      LEASE_DEFAULT_HOLD_MINUTES: '10',
      LEASE_MAX_HOLD_MINUTES: '20',
      LEASE_EXPECTED_DEPLOY_MINUTES: '0',
    }),
    { hold: 10, deploy: 0 }
  );
  assert.throws(() => leaseTiming({ LEASE_HOLD_MINUTES: '121' }), /exceeds cap/);
  for (const value of ['-1', '0', '1.2', 'NaN', 'Infinity'])
    assert.throws(() => leaseTiming({ LEASE_HOLD_MINUTES: value }), /integer/);
});

function store(initial = []) {
  const records = [...initial];
  const calls = [];
  return {
    records,
    calls,
    api: async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === 'POST') {
        const next = { ...body, id: records.length + 1 };
        records.unshift(next);
        return next;
      }
      if (endpoint.startsWith('/deployments?')) {
        const query = new URLSearchParams(endpoint.split('?')[1]);
        assert.equal(query.get('task'), LEASE_TASK);
        return records
          .filter((r) => r.environment === query.get('environment') && r.task === LEASE_TASK)
          .slice(0, 1);
      }
      return records.find((r) => endpoint === `/deployments/${r.id}`);
    },
  };
}
const options = {
  environment: 'staging',
  branch: 'holder',
  sha,
  taskId: 'task-1',
  timing: { deploy: 30, hold: 30 },
  now,
};

test('GitHub transport flow acquires, refuses without writing, renews, releases, and takes over expiry', async () => {
  const db = store();
  const run = (overrides = {}) => runLease({ ...options, api: db.api, ...overrides });
  const first = await run();
  assert.equal(first.expiresAt, '2026-11-15T20:00:00.000Z');
  assert.equal(db.calls.find((c) => c.method === 'POST').body.auto_merge, false);
  assert.deepEqual(db.calls.find((c) => c.method === 'POST').body.required_contexts, []);
  const writes = db.records.length;
  await assert.rejects(run({ branch: 'other' }), /held by branch holder/);
  assert.equal(db.records.length, writes);
  const renewed = await run({ now: now + 60_000 });
  assert.equal(renewed.expiresAt, '2026-11-15T20:01:00.000Z');
  await run({ action: 'release', now: now + 120_000 });
  const takeover = await run({ branch: 'other', now: now + 120_001 });
  assert.equal(takeover.branch, 'other');
  const expired = await run({ branch: 'third', now: Date.parse(takeover.expiresAt) });
  assert.equal(expired.branch, 'third');
});

test('environment selection isolates independent slots and ignores ordinary deployments', async () => {
  const db = store([{ ...record(), task: 'deploy' }, record()]);
  const result = await runLease({
    ...options,
    environment: 'staging-second',
    branch: 'other',
    api: db.api,
  });
  assert.equal(result.environment, 'staging-second');
  await assert.rejects(
    runLease({ ...options, branch: 'other', api: db.api }),
    /held by branch holder/
  );
});

test('API read/write errors, corrupt history, missing creation id and read-back mismatch block deploy', async () => {
  const db = store([record({ ...held, version: 2 })]);
  await assert.rejects(runLease({ ...options, api: db.api }), /Malformed/);
  assert.equal(db.calls.length, 1);
  await assert.rejects(
    runLease({
      ...options,
      api: async () => {
        throw new Error('403');
      },
    }),
    /403/
  );
  for (const response of [null, {}]) {
    await assert.rejects(runLease({ ...options, api: async () => response }), /Unreadable/);
  }
  await assert.rejects(
    runLease({ ...options, api: async (m) => (m === 'GET' ? [] : {}) }),
    /did not create/
  );
  const bad = store();
  await assert.rejects(
    runLease({
      ...options,
      api: async (...args) => {
        const value = await bad.api(...args);
        return args[1].includes('/deployments/')
          ? { ...value, payload: { ...value.payload, branch: 'wrong' } }
          : value;
      },
    }),
    /mismatch/
  );
});

test('production aliases and inconsistent environment casing fail before API access', async () => {
  for (const environment of ['production', 'Production', 'PRODUCTION', 'Staging', '']) {
    await assert.rejects(
      runLease({ ...options, environment, api: async () => assert.fail('no API access') }),
      /lowercase, non-production/
    );
  }
});

test('incomplete or impossible UTC expiry dates fail closed', () => {
  for (const expiresAt of [
    '2026',
    '2026-11',
    '2026-11-15',
    '2026-11-15T19:00:00',
    '2026-02-30T19:00:00Z',
    '2026-02-29T19:00:00.000Z',
    '2026-11-15T24:00:00Z',
    '2026-13-01T19:00:00Z',
  ]) {
    assert.throws(() => readLease(record({ ...held, expiresAt }), 'staging'), /Malformed/);
  }
  assert.equal(
    readLease(record({ ...held, expiresAt: '2028-02-29T19:00:00Z' }), 'staging').state,
    'held'
  );
});

test('unsupported legacy audits reject before acquiring a secondary slot', async () => {
  await assert.rejects(
    runLease({
      ...options,
      environment: 'staging-second',
      primaryOnlyAudit: true,
      api: async () => assert.fail('no lease mutation'),
    }),
    /support only the staging environment/
  );
  const db = store();
  assert.equal((await runLease({ ...options, primaryOnlyAudit: true, api: db.api })).state, 'held');
  assert.equal(
    (
      await runLease({
        ...options,
        environment: 'staging-second',
        primaryOnlyAudit: true,
        action: 'acquire',
        api: db.api,
      })
    ).state,
    'held'
  );
});
