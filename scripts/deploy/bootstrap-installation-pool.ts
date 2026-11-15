/**
 * Seed a secondary installation's shared compute pool, so VM work can start with no human
 * clicks. A new platform credential lists its machines in the installation pool but picks none
 * of them (compute-pools guide, "An empty pool runs only Instant sessions"), so this does what an
 * admin would do in Admin > Infrastructure, through the same API:
 *
 *   1. sign in as the bootstrap admin with the staging smoke token (token-login);
 *   2. reconcile the installation pool, which publishes the new credential's catalog;
 *   3. activate the machines the primary installation's pool has active, for the same
 *      provider, region and machine type. When the providers differ (for example the copy is
 *      GCP and the primary pool is Hetzner) it activates, per workload role, the cheapest
 *      available machines with at least `minMemoryMb` and `minVcpu`.
 *
 * It only ever activates machines; it never switches one off, so an admin's choices on the
 * secondary installation survive later deploys.
 */
import type { D1Like } from './bootstrap-staging-installation';

interface PoolCandidate {
  id: string;
  capacitySourceId: string;
  provider: string | null;
  location: string | null;
  workloadRole: string;
  providerInstanceType: string | null;
  providerInstanceVcpuCount: number | null;
  providerInstanceMemoryMb: number | null;
  providerInstancePriceHourlyMicros: number | null;
  status: string;
  catalogAvailability?: string;
}

interface PoolResponse {
  effective?: { candidates?: PoolCandidate[]; activeCandidateCount?: number } | null;
}

export interface PrimaryPick {
  provider: string;
  location: string;
  providerInstanceType: string;
  workloadRole: string;
}

export interface PoolSeedOptions {
  apiBaseUrl: string;
  appOrigin: string;
  smokeTestToken: string;
  primaryPicks: PrimaryPick[];
  /** The platform credential the bootstrap wrote; only its source's machines are activated. */
  credentialId: string;
  minMemoryMb?: number;
  minVcpu?: number;
  fallbackPerRole?: number;
  catalogWaitAttempts?: number;
  catalogWaitMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/** Defaults sized to admit default work (2 vCPU, 4 GB plus the 1 GiB host reserve). */
export const DEFAULT_POOL_SEED_MIN_MEMORY_MB = 8192;
export const DEFAULT_POOL_SEED_MIN_VCPU = 2;
export const DEFAULT_POOL_SEED_FALLBACK_PER_ROLE = 2;
export const DEFAULT_POOL_SEED_CATALOG_WAIT_ATTEMPTS = 12;
export const DEFAULT_POOL_SEED_CATALOG_WAIT_MS = 5000;

export async function readPrimaryPoolPicks(source: D1Like): Promise<PrimaryPick[]> {
  const rows = await source.all<{
    provider: string | null;
    location: string | null;
    provider_instance_type: string | null;
    workload_role: string;
  }>(
    `SELECT DISTINCT c.provider, c.location, c.provider_instance_type, c.workload_role
     FROM capacity_pool_candidates c JOIN capacity_pools p ON p.id = c.pool_id
     WHERE p.scope = 'installation' AND c.status = 'active'
     ORDER BY c.workload_role, c.provider, c.location, c.provider_instance_type`
  );
  return rows.flatMap((row) =>
    row.provider && row.location && row.provider_instance_type
      ? [
          {
            provider: row.provider,
            location: row.location,
            providerInstanceType: row.provider_instance_type,
            workloadRole: row.workload_role,
          },
        ]
      : []
  );
}

/** Which catalog rows to activate. Pure, so the choice is testable without an API. */
export function chooseCandidatesToActivate(
  candidates: PoolCandidate[],
  primaryPicks: PrimaryPick[],
  sourceId: string,
  limits: { minMemoryMb: number; minVcpu: number; fallbackPerRole: number }
): PoolCandidate[] {
  const ours = candidates.filter(
    (c) => c.capacitySourceId === sourceId && (c.catalogAvailability ?? 'available') === 'available'
  );
  const key = (p: {
    provider: string | null;
    location: string | null;
    providerInstanceType: string | null;
    workloadRole: string;
  }) => [p.provider, p.location, p.providerInstanceType, p.workloadRole].join('|');
  const wanted = new Set(primaryPicks.map(key));
  const mirrored = ours.filter((c) => wanted.has(key(c)));
  if (mirrored.length > 0) return mirrored;

  const byRole = new Map<string, PoolCandidate[]>();
  for (const candidate of ours) {
    if ((candidate.providerInstanceMemoryMb ?? 0) < limits.minMemoryMb) continue;
    if ((candidate.providerInstanceVcpuCount ?? 0) < limits.minVcpu) continue;
    byRole.set(candidate.workloadRole, [...(byRole.get(candidate.workloadRole) ?? []), candidate]);
  }
  return [...byRole.values()].flatMap((rows) =>
    rows
      .sort(
        (a, b) =>
          (a.providerInstancePriceHourlyMicros ?? Number.MAX_SAFE_INTEGER) -
            (b.providerInstancePriceHourlyMicros ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id)
      )
      .slice(0, limits.fallbackPerRole)
  );
}

export async function seedInstallationPool(options: PoolSeedOptions): Promise<{
  activated: number;
  alreadyActive: number;
  mirrored: boolean;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? ((message: string) => console.log(message));
  const sourceId = `cap-source-default:platform:${options.credentialId}`;
  const limits = {
    minMemoryMb: options.minMemoryMb ?? DEFAULT_POOL_SEED_MIN_MEMORY_MB,
    minVcpu: options.minVcpu ?? DEFAULT_POOL_SEED_MIN_VCPU,
    fallbackPerRole: options.fallbackPerRole ?? DEFAULT_POOL_SEED_FALLBACK_PER_ROLE,
  };

  const login = await fetchImpl(`${options.apiBaseUrl}/api/auth/token-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: options.appOrigin },
    body: JSON.stringify({ token: options.smokeTestToken }),
  });
  if (!login.ok) throw new Error(`Bootstrap admin sign-in failed: HTTP ${login.status}`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('Bootstrap admin sign-in returned no session cookie.');

  const call = async (method: string, path: string, body?: unknown): Promise<PoolResponse> => {
    const response = await fetchImpl(`${options.apiBaseUrl}/api/admin/capacity-pools${path}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: options.appOrigin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`${method} capacity-pools${path} failed: HTTP ${response.status} ${text}`);
    }
    return (await response.json()) as PoolResponse;
  };

  let candidates: PoolCandidate[] = [];
  const attempts = options.catalogWaitAttempts ?? DEFAULT_POOL_SEED_CATALOG_WAIT_ATTEMPTS;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const pool = await call('POST', '/defaults/reconcile');
    candidates = pool.effective?.candidates ?? [];
    if (candidates.some((c) => c.capacitySourceId === sourceId)) break;
    if (attempt < attempts) {
      log(`catalog for ${sourceId} not published yet (attempt ${attempt}/${attempts})`);
      await sleep(options.catalogWaitMs ?? DEFAULT_POOL_SEED_CATALOG_WAIT_MS);
    }
  }

  const chosen = chooseCandidatesToActivate(candidates, options.primaryPicks, sourceId, limits);
  if (chosen.length === 0) {
    throw new Error(
      `No machine in the ${sourceId} catalog matches the primary pool or the minimum size; the pool would stay empty.`
    );
  }
  const wanted = new Set(options.primaryPicks.map((p) => p.providerInstanceType));
  const mirrored = chosen.every(
    (c) => c.providerInstanceType && wanted.has(c.providerInstanceType)
  );
  const toActivate = chosen.filter((c) => c.status !== 'active');
  if (toActivate.length > 0) {
    await call('PATCH', '/defaults', {
      candidates: toActivate.map((c) => ({ id: c.id, status: 'active' })),
    });
  }
  log(
    `installation pool: ${toActivate.length} machine(s) activated, ${chosen.length - toActivate.length} already active (${mirrored ? 'mirrors the primary pool' : 'cheapest fitting machines'}): ${chosen
      .map((c) => `${c.workloadRole}:${c.provider}/${c.location}/${c.providerInstanceType}`)
      .join(', ')}`
  );
  return {
    activated: toActivate.length,
    alreadyActive: chosen.length - toActivate.length,
    mirrored,
  };
}
