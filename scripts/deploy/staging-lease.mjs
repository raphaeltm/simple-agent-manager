// Staging verification lease and queue: GitHub I/O and the deploy-staging.yml entry points.
// Decisions are pure functions in staging-lease-queue.mjs.
//
//   node scripts/deploy/staging-lease.mjs queue   # workflow job `queue`, outside the concurrency group
//   node scripts/deploy/staging-lease.mjs lease   # workflow job `lease`, serialized per installation
//   node scripts/deploy/staging-lease.mjs status <installation>   # read-only, one gh api call
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  LEASE_TASK,
  OLD_WORKFLOW_NOTICE,
  RECORD_PAGE_SIZE,
  applyReservation,
  decideLease,
  describeTurn,
  foldRecords,
  hasTurn,
  parseRecord,
  planQueue,
  position,
  resolveTurns,
} from './staging-lease-queue.mjs';

export { LEASE_TASK };

const ACTIONS = ['deploy', 'acquire', 'release', 'reserve'];
const SHA = /^[a-f0-9]{40}$/i;
const iso = (ms) => new Date(ms).toISOString();

function minutes(value, fallback, name, allowZero = false) {
  const number = Number(value === '' || value === undefined ? fallback : value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(
      `${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} integer in minutes`
    );
  }
  return number;
}

export function leaseTiming(env) {
  const cap = minutes(env.LEASE_MAX_HOLD_MINUTES, 120, 'LEASE_MAX_HOLD_MINUTES');
  const hold = minutes(
    env.LEASE_HOLD_MINUTES,
    env.LEASE_DEFAULT_HOLD_MINUTES || 30,
    'LEASE_HOLD_MINUTES'
  );
  if (hold > cap) throw new Error(`Requested hold ${hold} minutes exceeds cap ${cap}`);
  const deploy = minutes(
    env.LEASE_EXPECTED_DEPLOY_MINUTES,
    30,
    'LEASE_EXPECTED_DEPLOY_MINUTES',
    true
  );
  return { hold, deploy };
}

export function queueTiming(env) {
  return {
    graceMinutes: minutes(env.LEASE_GRACE_MINUTES, 10, 'LEASE_GRACE_MINUTES'),
    reservationMinutes: minutes(env.LEASE_RESERVATION_MINUTES, 480, 'LEASE_RESERVATION_MINUTES'),
  };
}

function validateRequest({ environment, branch, sha, action, primaryOnlyAudit }) {
  if (!environment || environment !== environment.toLowerCase() || /prod/i.test(environment))
    throw new Error('A lowercase, non-production environment is required');
  if (!branch || !SHA.test(sha ?? '')) throw new Error('Branch and full commit SHA are required');
  if (!ACTIONS.includes(action)) throw new Error('Unknown lease action');
  if (action === 'deploy' && primaryOnlyAudit && environment !== 'staging')
    throw new Error(
      'Storage activation and agent-email DNS audit support only the staging environment'
    );
}

async function readState(api, environment) {
  const query = new URLSearchParams({
    environment,
    task: LEASE_TASK,
    per_page: String(RECORD_PAGE_SIZE),
  });
  return foldRecords(await api('GET', `/deployments?${query}`), environment);
}

async function createRecord(api, { environment, sha, description, payload }) {
  const record = await api('POST', '/deployments', {
    ref: sha,
    task: LEASE_TASK,
    environment,
    auto_merge: false,
    required_contexts: [],
    production_environment: false,
    description,
    payload,
  });
  if (!record?.id) throw new Error('GitHub did not create a lease deployment record');
  return record;
}

function queueLines(turns) {
  if (turns.live.length === 0) return ['Queue: empty.'];
  return turns.live.map((entry, index) => `${index + 1}. ${describeTurn(entry)}`);
}

// Job `queue`: never inside the concurrency group, so nothing it writes can be lost to a cancelled
// pending run. Records the branch's place, then lets the run into the serialized lease job only
// if the branch holds the lease or it is the branch's turn now.
export async function runQueue({
  api,
  environment,
  branch,
  sha,
  taskId = '',
  action = 'deploy',
  primaryOnlyAudit = false,
  timing,
  now = Date.now(),
}) {
  validateRequest({ environment, branch, sha, action, primaryOnlyAudit });
  const { state, warnings } = await readState(api, environment);
  const plan = planQueue({ state, branch, action, now, graceMinutes: timing.graceMinutes });
  if (action === 'release') return { proceed: true, warnings, lines: ['Release requested.'] };
  if (plan.holds) {
    return {
      proceed: action !== 'reserve',
      warnings,
      lines: [`Branch ${branch} holds ${environment} until ${plan.turns.holder.expiresAt}.`],
    };
  }
  let turns = plan.turns;
  if (plan.append) {
    const entry = {
      branch,
      taskId,
      reservedAt: iso(now),
      expiresAt: iso(now + timing.reservationMinutes * 60_000),
    };
    await createRecord(api, {
      environment,
      sha,
      description: `Staging lease reservation: ${branch}`,
      payload: {
        version: 2,
        kind: 'reservation',
        environment,
        ...entry,
        notice: OLD_WORKFLOW_NOTICE,
      },
    });
    applyReservation(state, entry);
    turns = resolveTurns(state, now, timing.graceMinutes);
  }
  const mine = hasTurn(turns, branch);
  const where = position(turns, branch);
  const lines = [
    turns.holder
      ? `Holder: ${turns.holder.branch} (SAM task ${turns.holder.taskId || 'not supplied'}) until ${turns.holder.expiresAt}.`
      : 'Holder: none.',
    ...queueLines(turns),
    mine
      ? `It is ${branch}'s turn${action === 'reserve' ? ': run acquire or deploy before it ends' : ''}.`
      : `${branch} is number ${where} in the queue (reservation ${plan.append ? 'recorded' : 'already held'}). Schedule a wake for the turn start; do not dispatch again before it.`,
  ];
  return {
    proceed: action !== 'reserve' && mine,
    refused: action !== 'reserve' && !mine,
    warnings,
    lines,
  };
}

// Job `lease`: serialized per installation. Re-reads, decides authoritatively, writes a snapshot
// and reads it back before any deploy or audit job may start.
export async function runLease({
  api,
  environment,
  branch,
  sha,
  taskId = '',
  action = 'deploy',
  primaryOnlyAudit = false,
  timing,
  now = Date.now(),
}) {
  validateRequest({ environment, branch, sha, action, primaryOnlyAudit });
  if (action === 'reserve') throw new Error('Reservations are made by the queue job');
  const { state, warnings } = await readState(api, environment);
  const next = decideLease({
    state,
    branch,
    taskId,
    sha,
    action,
    now,
    environment,
    graceMinutes: timing.graceMinutes,
    holdMinutes: (action === 'deploy' ? timing.deploy : 0) + timing.hold,
  });
  if (!next) return { written: false, warnings, message: `Nothing held or queued by ${branch}.` };
  const payload = {
    version: 2,
    kind: 'snapshot',
    environment,
    seenThrough: state.seenThrough,
    graceMinutes: timing.graceMinutes,
    holder: next.holder,
    freeSince: next.freeSince,
    promisedAt: next.promisedAt,
    queue: next.queue,
    updatedAt: iso(now),
    notice: OLD_WORKFLOW_NOTICE,
  };
  const record = await createRecord(api, {
    environment,
    sha,
    description: `Staging lease: ${next.holder ? `held by ${next.holder.branch}` : 'free'}`,
    payload,
  });
  const saved = parseRecord(await api('GET', `/deployments/${record.id}`), environment);
  if (
    saved.type !== 'snapshot' ||
    JSON.stringify(saved.state.holder) !== JSON.stringify(next.holder)
  )
    throw new Error('Lease read-back mismatch');
  const holder = next.holder;
  return {
    written: true,
    deploymentId: record.id,
    warnings,
    holder,
    message: holder
      ? `Lease held: environment ${environment}, branch ${holder.branch}, SAM task ${holder.taskId || '(not supplied)'}, SHA ${holder.sha}, expires ${holder.expiresAt}, deployment ${record.id}`
      : `Lease released by ${branch}: environment ${environment}, deployment ${record.id}. Queue: ${next.queue.map((entry) => entry.branch).join(', ') || 'empty'}.`,
  };
}

// Read-only view for agents: one gh api call.
export async function leaseStatus({ api, environment, now = Date.now(), graceMinutes }) {
  const query = new URLSearchParams({
    environment,
    task: LEASE_TASK,
    per_page: String(RECORD_PAGE_SIZE),
  });
  const records = await api('GET', `/deployments?${query}`);
  const { state, warnings } = foldRecords(records, environment);
  const newest = records.find((record) => record.payload?.kind === 'snapshot');
  const grace = graceMinutes ?? newest?.payload?.graceMinutes ?? 10;
  const turns = resolveTurns(state, now, grace);
  return {
    environment,
    now: iso(now),
    graceMinutes: grace,
    holder: turns.holder,
    free: !turns.holder && turns.live.length === 0,
    queue: turns.live.map((entry, index) => ({
      position: index + 1,
      branch: entry.branch,
      taskId: entry.taskId,
      reservedAt: entry.reservedAt,
      reservationExpiresAt: entry.expiresAt,
      status: entry.status,
      turnStarts: iso(entry.start),
      turnEnds: iso(entry.end),
    })),
    warnings,
  };
}

function githubApi(method, endpoint, body) {
  const repo = process.env.GITHUB_REPOSITORY || '{owner}/{repo}';
  const args = ['api', '--method', method, `repos/${repo}${endpoint}`];
  if (body) args.push('--input', '-');
  return JSON.parse(
    execFileSync(process.env.GITHUB_ACTIONS === 'true' ? '/usr/bin/gh' : 'gh', args, {
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
    })
  );
}

function report(lines) {
  for (const line of lines) console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n\n')}\n`);
}

function workflowRequest() {
  if (process.env.GITHUB_ACTIONS !== 'true')
    throw new Error('Mutate leases only through deploy-staging.yml');
  return {
    api: githubApi,
    environment: process.env.LEASE_ENVIRONMENT,
    branch: process.env.GITHUB_REF_NAME,
    sha: process.env.GITHUB_SHA,
    primaryOnlyAudit: process.env.LEASE_PRIMARY_ONLY_AUDIT === 'true',
    taskId: process.env.SAM_TASK_ID || '',
    action: process.env.LEASE_ACTION || 'deploy',
  };
}

async function main(command, argument) {
  if (command === 'status') {
    console.log(
      JSON.stringify(
        await leaseStatus({ api: githubApi, environment: argument || 'staging' }),
        null,
        2
      )
    );
    return;
  }
  if (command === 'queue') {
    const result = await runQueue({ ...workflowRequest(), timing: queueTiming(process.env) });
    report([...result.warnings, ...result.lines]);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${result.proceed}\n`);
    if (result.refused) process.exitCode = 1;
    return;
  }
  if (command === 'lease') {
    const result = await runLease({
      ...workflowRequest(),
      timing: { ...leaseTiming(process.env), ...queueTiming(process.env) },
    });
    report([...result.warnings, result.message]);
    return;
  }
  throw new Error('Usage: staging-lease.mjs queue | lease | status <installation>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv[2], process.argv[3]);
  } catch (error) {
    console.error(`Lease refused: ${error.message}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Lease refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
