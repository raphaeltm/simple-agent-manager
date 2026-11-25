import { cloudflare, CloudflareError } from './cloudflare';
import {
  type AdoptionTarget,
  assertActiveZone,
  type InstallationPlan,
  stackForEnvironment,
  validateInstallationConfig,
  workersDevPlan,
} from './installation-plan';
import { digest } from './security';

/** A deployment's API Worker is `<prefix>-api-<stack>` (sync-wrangler-config.ts). */
const API_WORKER = /^([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)-api-([A-Za-z0-9][A-Za-z0-9_-]{0,31})$/;

/**
 * Plans taking over the SAM already running at the chosen domain. The deployment is found by
 * its API Worker route; its state bucket by the names the fork workflow and the installer use.
 * Anything that does not identify exactly one existing deployment is reported as a conflict, so
 * the owner can never approve a takeover of something else.
 */
export async function previewAdoption(token: string, input: unknown): Promise<InstallationPlan> {
  const requested = validateInstallationConfig({ ...(input as object), adoption: undefined });
  await assertActiveZone(token, requested);
  const workersDev = await workersDevPlan(token, requested.accountId);
  const conflicts: InstallationPlan['conflicts'] = [];
  const found = await findDeployment(token, requested.zoneId, requested.baseDomain);
  let adoption: AdoptionTarget | undefined;
  if (typeof found === 'string') conflicts.push({ name: found, type: 'adoption' });
  else {
    const stateBucket = await findStateBucket(token, requested.accountId, found);
    if (!stateBucket)
      conflicts.push({
        name: `no deploy state bucket named ${found.prefix}-pulumi-state or ${found.prefix}-pulumi-state-${found.environment}`,
        type: 'adoption',
      });
    else adoption = { ...found, stateBucket };
  }
  const c = { ...requested, ...(adoption ? { adoption } : {}) };
  return {
    ...c,
    workersDev,
    hostnames: ['api', 'app', 'preview', '*'].map((name) => `${name}.${c.baseDomain}`),
    conflicts,
    fingerprint: await digest(
      JSON.stringify({ ...c, workersDevSubdomain: workersDev.subdomain, takeover: true })
    ),
  };
}

async function findDeployment(
  token: string,
  zoneId: string,
  baseDomain: string
): Promise<Omit<AdoptionTarget, 'stateBucket'> | string> {
  const routes = await cloudflare<{ pattern?: unknown; script?: unknown }[]>(
    token,
    `/zones/${zoneId}/workers/routes`
  );
  if (!Array.isArray(routes)) throw new Error('Invalid Workers routes response');
  const scripts = new Set(
    routes.filter((route) => route.pattern === `api.${baseDomain}/*`).map((route) => route.script)
  );
  if (scripts.size === 0) return `no SAM API Worker routed at api.${baseDomain}`;
  if (scripts.size > 1) return `more than one Worker routed at api.${baseDomain}`;
  const [script] = [...scripts];
  const match = typeof script === 'string' ? API_WORKER.exec(script) : null;
  if (!match?.[1] || !match[2]) return `api.${baseDomain} is not served by a SAM API Worker`;
  const stack = match[2];
  return { prefix: match[1], environment: stack === 'prod' ? 'production' : stack };
}

async function findStateBucket(
  token: string,
  accountId: string,
  target: Omit<AdoptionTarget, 'stateBucket'>
): Promise<string | undefined> {
  // The fork workflow's default first (workflow-resource-names.mjs), then the installer's.
  for (const name of [
    `${target.prefix}-pulumi-state`,
    `${target.prefix}-pulumi-state-${target.environment}`,
  ]) {
    try {
      await cloudflare(token, `/accounts/${accountId}/r2/buckets/${name}`);
      return name;
    } catch (error) {
      if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
    }
  }
  return undefined;
}

/** Buckets a takeover's storage credential needs: its state, its assets and the build cache. */
export function adoptionCredentialBuckets(adoption: AdoptionTarget, maintenanceBucket: string) {
  return [
    adoption.stateBucket,
    `${adoption.prefix}-${stackForEnvironment(adoption.environment)}-assets`,
    maintenanceBucket,
  ];
}
