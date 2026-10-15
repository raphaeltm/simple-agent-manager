/** Verification-only Node/Playwright boundary. No credentials or live setup here. */
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const categories = new Set(['ok', 'configuration', 'timeout', 'network', 'response', 'malformed', 'controller']);
export const summary = (category, status = 0, accepted = false) => ({
  category: categories.has(category) ? category : 'configuration',
  status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0,
  checks: { requestSucceeded: category === 'ok', responseAccepted: accepted === true },
});
export function safeSummary(value) {
  try {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'category,checks,status'
      || !categories.has(value.category) || !Number.isInteger(value.status)
      || !(value.status === 0 || (value.status >= 100 && value.status <= 599))
      || !value.checks || Object.keys(value.checks).sort().join() !== 'requestSucceeded,responseAccepted'
      || Object.values(value.checks).some(v => typeof v !== 'boolean')) return summary('configuration');
    // Reconstruct: never serialize caller objects, getters, prototypes or toJSON hooks.
    return summary(value.category, value.status, value.checks.responseAccepted);
  } catch { return summary('configuration'); }
}
function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== value) throw new Error();
  return parsed.origin;
}
function target(base, path) {
  if (typeof path !== 'string' || !path.startsWith('/api/') || /[\\?#\x00-\x20]/u.test(path)) throw new Error();
  const url = new URL(path, base);
  if (url.origin !== base || !url.pathname.startsWith('/api/')) throw new Error();
  return url.href;
}
export async function requestSafe(context, trustedOrigin, command, accept) {
  let status = 0;
  try {
    const base = origin(trustedOrigin);
    const method = command.method ?? 'GET';
    const timeout = command.timeoutMs ?? 30_000;
    if (!['GET', 'POST', 'DELETE'].includes(method) || !Number.isFinite(timeout) || timeout <= 0) return summary('configuration');
    const response = await context.request.fetch(target(base, command.path), {
      method, data: command.data, headers: { Origin: base }, timeout,
      maxRedirects: 0, failOnStatusCode: false,
    });
    try {
      status = response.status();
      if (!Number.isInteger(status) || status < 100 || status > 599) return summary('malformed');
      if (status < 200 || status >= 300) return summary('response', status);
      if (!accept) return summary('ok', status, true);
      try {
        const accepted = await accept(await response.json());
        return typeof accepted === 'boolean' ? summary(accepted ? 'ok' : 'response', status, accepted) : summary('malformed', status);
      } catch { return summary('malformed', status); }
    } finally { try { await response.dispose(); } catch { /* Never expose diagnostics. */ } }
  } catch (error) {
    // Playwright's documented timeout class uses this name. Never inspect its message/stack.
    return summary(error?.name === 'TimeoutError' ? 'timeout' : 'network', status);
  }
}
export const logoutSafe = (context, trustedOrigin) => requestSafe(context, trustedOrigin,
  { method: 'POST', path: '/api/auth/sign-out', data: {} });
export async function screenshotSafe(page, trustedOrigin, path, privatePath) {
  try {
    const base = origin(trustedOrigin);
    if (typeof path !== 'string' || !path.startsWith('/') || /[\\?#\x00-\x20]/u.test(path)
      || new URL(path, base).origin !== base) return summary('configuration');
    await page.goto(new URL(path, base).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.screenshot({ path: privatePath, timeout: 30_000 });
    return summary('ok', 0, true);
  } catch (error) { return summary(error?.name === 'TimeoutError' ? 'timeout' : 'controller'); }
}

/** Run a trusted controller module in a private process. Deadline is for the ENTIRE job.
 * The module exports async run({requestSafe,logoutSafe,screenshotSafe,report}). It owns
 * the existing context lifecycle; it must not write raw errors/responses to files.
 */
export function supervise(entrypoint, { deadlineMs = 60_000 } = {}) {
  return new Promise(resolve => {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) {
      resolve(summary('configuration')); return;
    }
    let child, timer, finished = false;
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child?.kill('SIGKILL'); } catch {} }
      resolve(safeSummary(value));
    };
    try {
      child = fork(fileURLToPath(import.meta.url), ['--private-worker', entrypoint], {
        detached: true, silent: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, DEBUG: '', PWDEBUG: '', NODE_DEBUG: '', NODE_OPTIONS: '' },
        execArgv: [],
      });
      // Discard every arbitrary child message. Only the final validated envelope is used.
      child.on('message', value => { if (value?.kind === 'finished') finish(value.result); });
      child.on('error', () => finish(summary('controller')));
      child.on('exit', () => finish(summary('controller')));
      timer = setTimeout(() => finish(summary('timeout')), deadlineMs);
    } catch { finish(summary('controller')); }
  });
}

async function worker(entrypoint) {
  const keepAlive = setInterval(() => {}, 60_000); // Supervisor owns the finite job deadline.
  const fatal = () => { try { process.send?.({ kind: 'finished', result: summary('controller') }); } finally { process.exitCode = 1; } };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  try {
    const controller = await import(pathToFileURL(entrypoint).href);
    // The returned summary is final: startup/login/goto/close/finally all belong inside run.
    const value = await controller.run({ requestSafe, logoutSafe, screenshotSafe,
      report: () => {} }); // No arbitrary progress output crosses the process boundary.
    process.send?.({ kind: 'finished', result: safeSummary(value) });
  } catch { fatal(); } finally { clearInterval(keepAlive); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--private-worker') await worker(process.argv[3]);
  else {
    let result;
    try { result = await supervise(process.argv[2], { deadlineMs: Number(process.argv[3] ?? 60_000) }); }
    catch { result = summary('controller'); }
    process.stdout.write(JSON.stringify(safeSummary(result)) + '\n');
  }
}

/** Typed private state only. No generic body/text fallback. Unknown fields are dropped. */
export function privateState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const ids = new Set(['id', 'taskId', 'workspaceId', 'nodeId', 'agentSessionId', 'chatSessionId', 'evidenceId']);
  const states = new Set(['pending','queued','running','in_progress','completed','failed','cancelled','stopped','creating','ready','sleeping','waking','idle','prompting','settling','inactive','active','awaiting_followup']);
  const output = {};
  for (const key of ids) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (typeof payload[key] !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(payload[key])) return null;
    output[key] = payload[key];
  }
  for (const key of ['status','taskStatus','activity','runtimeWorkState','executionStep']) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (!states.has(payload[key])) return null;
    output[key] = payload[key];
  }
  for (const key of ['activityAt','runtimeWorkUpdatedAt','runtimeWorkProgressAt','runtimeWorkCount']) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (!Number.isSafeInteger(payload[key]) || payload[key] < 0) return null;
    output[key] = payload[key];
  }
  for (const key of ['createdAt','completedAt','updatedAt']) {
    if (payload[key] === undefined || payload[key] === null) continue;
    if (typeof payload[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(payload[key]) || !Number.isFinite(Date.parse(payload[key]))) return null;
    output[key] = payload[key];
  }
  return Object.keys(output).length ? output : null;
}
