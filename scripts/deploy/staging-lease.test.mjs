// I/O and validation paths of the lease entry points. Queue behaviour: staging-lease-queue.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEASE_TASK, leaseTiming, queueTiming, runLease, runQueue } from './staging-lease.mjs';
import { validUtc } from './staging-lease-queue.mjs';

const now = Date.parse('2026-11-15T19:00:00Z');
const sha = 'a'.repeat(40);
const timing = { deploy: 30, hold: 30, graceMinutes: 10, reservationMinutes: 480 };
const options = { environment: 'staging', branch: 'holder', sha, taskId: 'task-1', timing, now };

function store() {
  const records = [];
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
        if ((query.get('page') ?? '1') !== '1') return [];
        return records.filter((r) => r.environment === query.get('environment'));
      }
      return records.find((r) => endpoint === `/deployments/${r.id}`);
    },
  };
}

test('hold, grace and reservation durations are configurable; unsafe values rejected', () => {
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
  for (const value of ['-1', '0', '1.2', 'NaN', 'Infinity']) {
    assert.throws(() => leaseTiming({ LEASE_HOLD_MINUTES: value }), /integer/);
    assert.throws(() => queueTiming({ LEASE_GRACE_MINUTES: value }), /integer/);
  }
  assert.deepEqual(queueTiming({}), { graceMinutes: 10, reservationMinutes: 480 });
  assert.deepEqual(queueTiming({ LEASE_GRACE_MINUTES: '5', LEASE_RESERVATION_MINUTES: '60' }), {
    graceMinutes: 5,
    reservationMinutes: 60,
  });
});

test('lease records are plain deployment records the lease job reads back before deploying', async () => {
  const db = store();
  await runQueue({ ...options, api: db.api });
  const result = await runLease({ ...options, api: db.api });
  assert.equal(result.holder.expiresAt, '2026-11-15T20:00:00.000Z');
  for (const call of db.calls.filter((c) => c.method === 'POST')) {
    assert.equal(call.body.auto_merge, false);
    assert.deepEqual(call.body.required_contexts, []);
    assert.equal(call.body.production_environment, false);
    assert.equal(call.body.ref, sha);
  }
  assert.ok(db.calls.at(-1).endpoint.startsWith('/deployments/'));
  // acquire holds only for the live-check time.
  const renewed = await runLease({ ...options, api: db.api, action: 'acquire', now: now + 60_000 });
  assert.equal(renewed.holder.expiresAt, '2026-11-15T19:31:00.000Z');
});

test('API errors, unreadable lists, missing creation id and read-back mismatch block the deploy', async () => {
  const failing = async () => {
    throw new Error('403');
  };
  await assert.rejects(runQueue({ ...options, api: failing }), /403/);
  await assert.rejects(runLease({ ...options, api: failing }), /403/);
  for (const response of [null, {}]) {
    await assert.rejects(runLease({ ...options, api: async () => response }), /Unreadable/);
    await assert.rejects(runQueue({ ...options, api: async () => response }), /Unreadable/);
  }
  await assert.rejects(
    runLease({ ...options, api: async (m) => (m === 'GET' ? [] : {}) }),
    /did not create/
  );
  await assert.rejects(
    runQueue({ ...options, api: async (m) => (m === 'GET' ? [] : {}) }),
    /did not create/
  );
  const bad = store();
  await assert.rejects(
    runLease({
      ...options,
      api: async (...args) => {
        const value = await bad.api(...args);
        return args[1].startsWith('/deployments/')
          ? {
              ...value,
              payload: { ...value.payload, holder: { ...value.payload.holder, branch: 'wrong' } },
            }
          : value;
      },
    }),
    /mismatch/
  );
});

test('production in any spelling, inconsistent casing and unknown actions fail before API access', async () => {
  const noApi = async () => assert.fail('no API access');
  for (const environment of ['production', 'Production', 'prod', 'staging-prod', 'Staging', '']) {
    await assert.rejects(
      runQueue({ ...options, environment, api: noApi }),
      /lowercase, non-production/
    );
    await assert.rejects(
      runLease({ ...options, environment, api: noApi }),
      /lowercase, non-production/
    );
  }
  await assert.rejects(
    runQueue({ ...options, action: 'steal', api: noApi }),
    /Unknown lease action/
  );
  await assert.rejects(runLease({ ...options, action: 'reserve', api: noApi }), /queue job/);
  await assert.rejects(runQueue({ ...options, sha: 'abc', api: noApi }), /full commit SHA/);
});

test('incomplete or impossible UTC dates are invalid', () => {
  for (const value of [
    '2026',
    '2026-11-15',
    '2026-11-15T19:00:00',
    '2026-02-30T19:00:00Z',
    '2026-02-29T19:00:00.000Z',
    '2026-11-15T24:00:00Z',
  ])
    assert.equal(validUtc(value), false, value);
  assert.equal(validUtc('2028-02-29T19:00:00Z'), true);
});

test('primary-only audits are refused on a secondary installation before any record is written', async () => {
  const noApi = async () => assert.fail('no lease mutation');
  for (const run of [runQueue, runLease]) {
    await assert.rejects(
      run({ ...options, environment: 'staging2', primaryOnlyAudit: true, api: noApi }),
      /support only the staging environment/
    );
  }
  const db = store();
  assert.equal((await runQueue({ ...options, primaryOnlyAudit: true, api: db.api })).proceed, true);
  assert.equal(
    (
      await runQueue({
        ...options,
        environment: 'staging2',
        primaryOnlyAudit: true,
        action: 'acquire',
        api: db.api,
      })
    ).proceed,
    true
  );
});
