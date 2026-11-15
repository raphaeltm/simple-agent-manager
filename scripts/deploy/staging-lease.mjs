import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Separate from GitHub Actions' ordinary environment deployment records.
export const LEASE_TASK = 'staging-lease';

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

export function readLease(record, environment) {
  if (record === undefined) return null; // No history: bootstrap a new environment.
  let lease = record.payload;
  if (typeof lease === 'string') {
    try {
      lease = JSON.parse(lease);
    } catch {
      throw new Error('Malformed lease payload');
    }
  }
  if (
    record.environment !== environment ||
    record.task !== LEASE_TASK ||
    lease?.version !== 1 ||
    lease.environment !== environment ||
    !['held', 'released'].includes(lease.state) ||
    typeof lease.branch !== 'string' ||
    !lease.branch ||
    !/^[a-f0-9]{40}$/i.test(lease.sha) ||
    typeof lease.taskId !== 'string' ||
    typeof lease.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(lease.expiresAt))
  ) {
    throw new Error(
      'Malformed lease record; refusing to overwrite live verification. Inspect the latest deployment payload.'
    );
  }
  return lease;
}

export function decideLease({ lease, branch, now, action }) {
  if (!['deploy', 'acquire', 'release'].includes(action)) throw new Error('Unknown lease action');
  if (lease?.state === 'held' && lease.branch !== branch && Date.parse(lease.expiresAt) > now) {
    throw new Error(
      `Environment ${lease.environment} held by branch ${lease.branch}, SAM task ${lease.taskId || '(not supplied)'}, expires ${lease.expiresAt}. Schedule a wake at expiry; do not poll or ask in chat.`
    );
  }
  if (action === 'release' && lease?.branch !== branch && lease?.state === 'held') {
    throw new Error(
      `Only holder branch ${lease.branch} may release this lease (expired leases can be acquired).`
    );
  }
  return action === 'release' ? 'released' : 'held';
}

// Keep all mutations in the workflow's environment-keyed concurrency group.
// Agents read with gh api; running acquire/release locally would bypass serialization.
export async function runLease({
  api,
  environment,
  branch,
  sha,
  taskId = '',
  action = 'deploy',
  timing,
  now = Date.now(),
}) {
  if (!environment || environment !== environment.toLowerCase() || environment === 'production')
    throw new Error('A lowercase, non-production environment is required');
  if (!branch || !/^[a-f0-9]{40}$/i.test(sha))
    throw new Error('Branch and full commit SHA are required');
  const query = new URLSearchParams({ environment, task: LEASE_TASK, per_page: '1' });
  const records = await api('GET', `/deployments?${query}`);
  if (!Array.isArray(records))
    throw new Error('Unreadable deployment list; refusing lease mutation');
  const lease = readLease(records[0], environment);
  const state = decideLease({ lease, branch, now, action });
  const expiresAt = new Date(
    now + (state === 'released' ? 0 : timing.deploy + timing.hold) * 60_000
  ).toISOString();
  const payload = { version: 1, environment, state, branch, sha, taskId, expiresAt };
  const record = await api('POST', '/deployments', {
    ref: sha,
    task: LEASE_TASK,
    environment,
    auto_merge: false,
    required_contexts: [],
    production_environment: false,
    description: `Verification lease: ${state}`,
    payload,
  });
  if (!record?.id) throw new Error('GitHub did not create a lease deployment record');
  // Re-read with the same token before allowing a deployment to start.
  const verified = await api('GET', `/deployments/${record.id}`);
  const saved = readLease(verified, environment);
  if (Object.entries(payload).some(([key, value]) => saved[key] !== value))
    throw new Error('Lease read-back mismatch');
  return { deploymentId: record.id, ...payload };
}

function githubApi(method, endpoint, body) {
  const args = ['api', '--method', method, `repos/${process.env.GITHUB_REPOSITORY}${endpoint}`];
  if (body) args.push('--input', '-');
  return JSON.parse(
    execFileSync('/usr/bin/gh', args, {
      encoding: 'utf8',
      input: body ? JSON.stringify(body) : undefined,
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true')
      throw new Error('Mutate leases only through deploy-staging.yml (serialized)');
    const result = await runLease({
      api: githubApi,
      environment: process.env.LEASE_ENVIRONMENT,
      branch: process.env.GITHUB_REF_NAME,
      sha: process.env.GITHUB_SHA,
      taskId: process.env.SAM_TASK_ID || '',
      action: process.env.LEASE_ACTION || 'deploy',
      timing: leaseTiming(process.env),
    });
    const message = `Lease ${result.state}: environment ${result.environment}, branch ${result.branch}, SAM task ${result.taskId || '(not supplied)'}, SHA ${result.sha}, expires ${result.expiresAt}, deployment ${result.deploymentId}`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch (error) {
    console.error(`Lease refused: ${error.message}`);
    process.exitCode = 1;
  }
}
