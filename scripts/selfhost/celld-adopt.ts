/**
 * Making celld serve a version the deploy just wrote, and checking it.
 *
 * celld 0.6.3 nodes read `deploy/current.json` every `CELLD_DEPLOY_POLL_S` seconds (default 30)
 * and adopt a new version in place; `POST /reload` on the internal listener adopts it at once
 * (celld `docs/README.md`, "A running node does not restart for a new deployment";
 * `internal_reload` in `crates/celld/main.rs`: 200 `adopted`/`unchanged`, 422 `failed` when the
 * version does not build, in which case the previous version keeps serving).
 *
 * Box round R15 (G3): `pnpm selfhost:deploy` did not ask, so its health check passed on the
 * PREVIOUS version and "deployed" was printed while that version served for up to one poll
 * interval. A deploy that added `AGENT_SIGN_IN_TRUST` answered 404 on the agent sign-in route for
 * about 20 s. The deploy now asks celld to adopt before its health check (`adoptNewDeployment`)
 * and checks the agent sign-in route when the trust is configured (`checkAgentSignInRoute`).
 */
import { intEnv, sleep, waitForHealth } from './deploy-steps.js';

/**
 * How long a check after a deploy keeps trying. celld can stall for seconds while it adopts a
 * version (6.5 s on sam-box in box round R11), and one refused fetch then failed a rotation that
 * `rotate --resume` finished at once. A version that is really broken still fails, after this
 * window. Override with SELFHOST_ADOPT_CHECK_WINDOW_MS.
 */
export const DEFAULT_ADOPT_CHECK_WINDOW_MS = 30_000;
const DEFAULT_ADOPT_POLL_INTERVAL_MS = 2000;
const DEFAULT_RELOAD_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HEALTH_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ROUTE_REQUEST_TIMEOUT_MS = 10_000;
/** The agent sign-in exchange route (apps/api/src/services/agent-sign-in/config.ts). */
export const AGENT_SIGN_IN_PATH = '/api/auth/workload-identity-login';
const MAX_DETAIL_CHARS = 300;

type Box = Readonly<Record<string, string>>;

export interface AdoptionResult {
  /** celld serves the version `deploy/current.json` names. */
  adopted: boolean;
  /** celld refused it because it did not build: retrying cannot help. */
  buildFailed: boolean;
  detail: string;
}

function windowDeadline(): number {
  return Date.now() + intEnv('SELFHOST_ADOPT_CHECK_WINDOW_MS', DEFAULT_ADOPT_CHECK_WINDOW_MS);
}

function pollInterval(): number {
  return intEnv('SELFHOST_HEALTH_POLL_INTERVAL_MS', DEFAULT_ADOPT_POLL_INTERVAL_MS);
}

function apiHeaders(box: Box): Record<string, string> {
  return { host: `api.${box.SAM_DOMAIN ?? ''}`, 'x-forwarded-proto': 'https' };
}

/** One `POST /reload` on celld's internal listener. Never throws. */
export async function requestAdoption(box: Box): Promise<AdoptionResult> {
  const internal = box.CELLD_INTERNAL_PORT || '7001';
  const reload = await fetch(`http://127.0.0.1:${internal}/reload`, {
    method: 'POST',
    signal: AbortSignal.timeout(DEFAULT_RELOAD_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => error);
  if (!(reload instanceof Response)) {
    return {
      adopted: false,
      buildFailed: false,
      detail: `celld did not adopt the deployment (${String(reload)})`,
    };
  }
  const body = (await reload.text().catch(() => '')).slice(0, 2000);
  let parsed: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(body);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const version = typeof parsed.version === 'string' ? ` version ${parsed.version}` : '';
  if (reload.ok) {
    const outcome = typeof parsed.outcome === 'string' ? parsed.outcome : 'adopted';
    return { adopted: true, buildFailed: false, detail: `${outcome}${version}` };
  }
  const error =
    typeof parsed.error === 'string' ? `: ${parsed.error.slice(0, MAX_DETAIL_CHARS)}` : '';
  // celld before 0.6.3 has no /reload; the deploy pins 0.6.3 (versions.ts CELLD_VERSION).
  const tooOld = reload.status === 404 ? '; celld 0.6.3 or later is needed for /reload' : '';
  const buildFailed = reload.status === 422;
  return {
    adopted: false,
    buildFailed,
    detail:
      `celld did not adopt the deployment (HTTP ${reload.status}${version}${error})${tooOld}` +
      (buildFailed ? '. The previous version keeps serving' : ''),
  };
}

/**
 * Runs `attempt` until `done` accepts its result or the window would end, then returns the last
 * result. Attempts are sequential on purpose: each is a retry of the one before.
 */
async function pollWithinWindow<T>(
  attempt: () => Promise<T>,
  done: (result: T) => boolean,
  deadline: number
): Promise<T> {
  const result = await attempt();
  if (done(result) || Date.now() + pollInterval() >= deadline) return result;
  await sleep(pollInterval());
  return pollWithinWindow(attempt, done, deadline);
}

/**
 * Asks celld to adopt the newest deployment now, retrying a refused or failed request within the
 * window. Throws when the version did not build (celld keeps the previous one serving) or when
 * celld never answered, so a deploy cannot report success while the old version serves.
 */
export async function adoptNewDeployment(box: Box): Promise<string> {
  const result = await pollWithinWindow(
    () => requestAdoption(box),
    (r) => r.adopted || r.buildFailed,
    windowDeadline()
  );
  if (result.adopted) return result.detail;
  if (result.buildFailed) throw new Error(`${result.detail}.`);
  throw new Error(
    `${result.detail}. celld adopts it by itself within CELLD_DEPLOY_POLL_S (default 30 s); ` +
      'check docker compose ps and the celld log, then run pnpm selfhost:deploy again.'
  );
}

/**
 * celld adopts the newest deployment now; then the API must answer its health check. Both are
 * retried until the window ends (the reload only re-reads deploy/current.json, so repeating it is
 * safe), as `pnpm selfhost:deploy`'s own health wait does (waitForHealth in deploy-steps.ts).
 */
export async function adoptAndCheck(box: Box): Promise<{ healthy: boolean; detail: string }> {
  const result = await pollWithinWindow(
    () => adoptAndCheckOnce(box),
    (r) => r.healthy || Boolean(r.final),
    windowDeadline()
  );
  return { healthy: result.healthy, detail: result.detail };
}

/** `final`: a version that did not build; retrying cannot change the answer. */
async function adoptAndCheckOnce(
  box: Box
): Promise<{ healthy: boolean; detail: string; final?: boolean }> {
  const adoption = await requestAdoption(box);
  if (!adoption.adopted) {
    return { healthy: false, detail: adoption.detail, final: adoption.buildFailed };
  }
  const health = await fetch(`http://127.0.0.1:${box.CELLD_PORT || '8080'}/health`, {
    headers: apiHeaders(box),
    signal: AbortSignal.timeout(DEFAULT_HEALTH_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => error);
  if (!(health instanceof Response)) return { healthy: false, detail: String(health) };
  if (health.ok) return { healthy: true, detail: 'HTTP 200' };
  const body = (await health.text()).slice(0, MAX_DETAIL_CHARS);
  const code = /"code"\s*:\s*"([A-Z_]+)"/.exec(body)?.[1];
  const suffix = code ? ` ${code}` : '';
  return { healthy: false, detail: `HTTP ${health.status}${suffix}` };
}

/** One POST of an empty body to the agent sign-in route: present, or what answered instead. */
async function probeAgentSignInRoute(box: Box): Promise<{ present: boolean; answer: string }> {
  const url = `http://127.0.0.1:${box.CELLD_PORT || '8080'}${AGENT_SIGN_IN_PATH}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...apiHeaders(box), 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(DEFAULT_ROUTE_REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => error);
  if (!(response instanceof Response)) return { present: false, answer: String(response) };
  await response.arrayBuffer().catch(() => undefined);
  return {
    present: response.status !== 404 && response.status < 500,
    answer: `HTTP ${response.status}`,
  };
}

/**
 * With `AGENT_SIGN_IN_TRUST` configured, the agent sign-in route must exist on the version that
 * now serves. An empty body is refused with 400 before any token is looked at; 404 means the route
 * stepped aside because the Worker has no usable trust (an unparseable value logs
 * `agent_sign_in.config_invalid`). Retried within the window, then throws.
 */
export async function checkAgentSignInRoute(box: Box): Promise<void> {
  const probe = await pollWithinWindow(
    () => probeAgentSignInRoute(box),
    (r) => r.present,
    windowDeadline()
  );
  if (probe.present) return;
  throw new Error(
    `AGENT_SIGN_IN_TRUST is set in secrets.env but POST ${AGENT_SIGN_IN_PATH} answers ${probe.answer}: ` +
      'the Worker has no usable trust. Look for agent_sign_in.config_invalid in the celld log ' +
      '(docker compose logs celld), fix the value and deploy again.'
  );
}

/**
 * What `pnpm selfhost:deploy` runs after `celld deploy`: celld adopts the new version, then the
 * API answers `/health`, then (with `AGENT_SIGN_IN_TRUST` among the Worker's secrets) the agent
 * sign-in route answers. In this order, so the checks reach the new version (box round R15, G3).
 */
export async function verifyNewVersionServes(
  box: Box,
  input: { celldPort: string; baseDomain: string; agentSignInConfigured: boolean },
  log: (message: string) => void
): Promise<void> {
  log(`celld adopted the new version: ${await adoptNewDeployment(box)}`);
  await waitForHealth(input.celldPort, input.baseDomain);
  if (input.agentSignInConfigured) {
    await checkAgentSignInRoute(box);
    log('agent sign-in route answers on the new version');
  }
}
