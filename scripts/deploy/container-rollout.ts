/** Read-only deployment gate. Never log configurations: they may contain launch secrets. */
export const DEFAULT_CONTAINER_ROLLOUT_TIMEOUT_MS = 1_200_000;
export const DEFAULT_CONTAINER_ROLLOUT_POLL_INTERVAL_MS = 10_000;
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
interface Application {
  id: string;
  name: string;
  version: number;
}
export interface Rollout {
  id: string;
  status: string;
  target_version: number;
  steps: { status: string; step_size: { percentage: number } }[];
}
export interface Snapshot {
  name: string;
  applicationId: string | null;
  version: number | null;
  rollouts: { id: string; target_version: number }[];
}
export interface RolloutApi {
  applications(): Promise<Application[]>;
  rollouts(id: string): Promise<Rollout[]>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unreadable container API record');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new Error('Unreadable container API identifier/status');
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Unreadable container API version');
  return value as number;
}
export function parseSnapshot(value: unknown): Snapshot[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Unreadable container snapshot');
  return value.map((value) => {
    const s = record(value);
    return {
      name: text(s.name),
      applicationId: s.applicationId === null ? null : text(s.applicationId),
      version: s.version === null ? null : version(s.version),
      rollouts: parseIdentities(s.rollouts),
    };
  });
}
function parseIdentities(value: unknown): Snapshot['rollouts'] {
  if (!Array.isArray(value)) throw new Error('Unreadable container rollout identities');
  const identities = value.map((value) => {
    const r = record(value);
    return { id: text(r.id), target_version: version(r.target_version) };
  });
  if (new Set(identities.map((r) => r.id)).size !== identities.length)
    throw new Error('Duplicate container rollout identities');
  return identities;
}
export function readRolloutTiming(env: NodeJS.ProcessEnv) {
  function positive(name: string, fallback: number) {
    const raw = env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive integer`);
    return value;
  }
  return {
    timeoutMs: positive('CONTAINER_ROLLOUT_TIMEOUT_MS', DEFAULT_CONTAINER_ROLLOUT_TIMEOUT_MS),
    pollIntervalMs: positive(
      'CONTAINER_ROLLOUT_POLL_INTERVAL_MS',
      DEFAULT_CONTAINER_ROLLOUT_POLL_INTERVAL_MS
    ),
  };
}
export function createRolloutApi(
  account: string,
  token: string,
  signal: AbortSignal,
  fetcher = fetch
): RolloutApi {
  async function request(path: string): Promise<unknown[]> {
    let response: Response;
    try {
      response = await fetcher(
        `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(account)}/containers/applications${path}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal,
        }
      );
    } catch {
      throw new Error('Container rollout API request failed');
    }
    if (!response.ok) throw new Error(`Container rollout API HTTP ${response.status}`);
    let payload: Record<string, unknown>;
    try {
      payload = record(await response.json());
    } catch {
      throw new Error('Unreadable container rollout API response');
    }
    if (payload.success !== true || !Array.isArray(payload.result))
      throw new Error('Unreadable container rollout API result');
    if (payload.result_info) {
      const info = record(payload.result_info);
      if (
        (typeof info.total_count === 'number' && info.total_count > payload.result.length) ||
        (typeof info.total_pages === 'number' &&
          typeof info.page === 'number' &&
          info.page < info.total_pages)
      )
        throw new Error('Incomplete container rollout API page');
    }
    return payload.result;
  }
  return {
    async applications() {
      return (await request('')).map((value) => {
        const a = record(value);
        return { id: text(a.id), name: text(a.name), version: version(a.version) };
      });
    },
    async rollouts(id) {
      return (await request(`/${encodeURIComponent(id)}/rollouts`)).map((value) => {
        const r = record(value);
        if (!Array.isArray(r.steps) || !r.steps.length)
          throw new Error('Unreadable container rollout steps');
        return {
          id: text(r.id),
          status: text(r.status),
          target_version: version(r.target_version),
          steps: r.steps.map((value) => {
            const step = record(value);
            const percentage = version(record(step.step_size).percentage);
            if (percentage > 100) throw new Error('Unreadable container rollout percentage');
            return { status: text(step.status), step_size: { percentage } };
          }),
        };
      });
    },
  };
}
function latest(rollouts: Rollout[]): Rollout | undefined {
  return [...rollouts].sort((a, b) => b.target_version - a.target_version)[0];
}
export async function snapshotApplications(api: RolloutApi, names: string[]): Promise<Snapshot[]> {
  const applications = await api.applications();
  return Promise.all(
    names.map(async (name) => {
      const app = applications.find((a) => a.name === name);
      return {
        name,
        applicationId: app?.id ?? null,
        version: app?.version ?? null,
        rollouts: app ? parseIdentities(await api.rollouts(app.id)) : [],
      };
    })
  );
}
export async function waitForContainerRollouts(
  api: RolloutApi,
  before: Snapshot[],
  options: {
    timeoutMs: number;
    pollIntervalMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  }
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.log;
  const deadline = now() + options.timeoutMs;
  // Pin once; never silently verify a superseding deployment.
  const targets = new Map<
    string,
    { applicationId: string; rolloutId: string | null; version: number }
  >();
  let status = 'not read';
  while (now() < deadline) {
    try {
      const applications = await api.applications();
      let complete = true;
      for (const prior of before) {
        const app = applications.find((a) => a.name === prior.name);
        if (!app || (prior.applicationId && prior.applicationId !== app.id))
          throw new Error(`Missing/replaced application ${prior.name}`);
        const rollouts = await api.rollouts(app.id);
        parseIdentities(rollouts);
        const newRollouts = rollouts.filter((r) => !prior.rollouts.some((p) => p.id === r.id));
        status = `application=${app.id} version=${app.version} newRollouts=${newRollouts.map((r) => `${r.id}:${r.target_version}`).join(',') || 'none'}`;
        if (newRollouts.length > 1) throw new Error('Ambiguous/superseding container rollouts');
        const candidate = newRollouts[0] ?? latest(rollouts);
        if (!newRollouts.length && prior.rollouts.length && !candidate)
          throw new Error('Prior container rollout history disappeared');
        if (
          rollouts.some((r) =>
            prior.rollouts.some((p) => p.id === r.id && p.target_version !== r.target_version)
          )
        )
          throw new Error('Container rollout target version changed');
        const target = targets.get(prior.name);
        if (prior.version !== null && app.version < prior.version)
          throw new Error('Application version regressed');
        if (!target) {
          if (
            newRollouts.length &&
            ((prior.version !== null && candidate.target_version <= prior.version) ||
              prior.rollouts.some((r) => r.target_version >= candidate.target_version))
          )
            throw new Error('New rollout target did not advance');
          targets.set(prior.name, {
            applicationId: app.id,
            rolloutId: candidate?.id ?? null,
            version: candidate?.target_version ?? app.version,
          });
        } else if (
          target.applicationId !== app.id ||
          target.rolloutId !== (candidate?.id ?? null) ||
          target.version !== (candidate?.target_version ?? app.version)
        )
          throw new Error('Target container rollout was superseded');
        const pinned = targets.get(prior.name);
        if (!pinned) throw new Error('Missing pinned rollout target');
        const rollout = rollouts.find((r) => r.id === pinned.rolloutId);
        if (pinned.rolloutId && !rollout) throw new Error('Pinned container rollout disappeared');
        // A metadata-only update can advance app.version without a new rollout.
        // A newly created rollout must finish at its exact target version.
        if (newRollouts.length && app.version > pinned.version)
          throw new Error('Target container rollout was superseded');
        status = `application=${app.id} rollout=${rollout?.id ?? 'none'} status=${rollout?.status ?? 'direct-create'} version=${app.version} target=${pinned.version}`;
        log(status);
        if (rollout) {
          if (['failed', 'cancelled', 'canceled'].includes(rollout.status))
            throw new Error('Container rollout failed');
          if (!['pending', 'progressing', 'completed'].includes(rollout.status))
            throw new Error('Unreadable container rollout status');
          const done =
            rollout.status === 'completed' &&
            rollout.steps.every((s) => s.status === 'completed') &&
            rollout.steps.at(-1)?.step_size.percentage === 100;
          if (rollout.status === 'completed' && !done)
            throw new Error('Completed rollout has unreadable/non-100% steps');
          complete &&=
            done &&
            (newRollouts.length ? app.version === pinned.version : app.version >= pinned.version);
        }
      }
      if (complete) return;
    } catch (error) {
      throw new Error(
        `Container rollout gate failed (${status}): ${error instanceof Error ? error.message : 'unreadable API state'}`
      );
    }
    await sleep(Math.min(options.pollIntervalMs, Math.max(0, deadline - now())));
  }
  throw new Error(`Container rollout timed out after ${options.timeoutMs}ms (${status})`);
}
