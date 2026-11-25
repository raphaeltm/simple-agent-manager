import { cloudflare, CloudflareError } from './cloudflare';
import {
  type AdoptionTarget,
  assertActiveZone,
  BUCKET_NAME,
  DEPLOYMENT_PREFIX,
  DEPLOYMENT_STACK,
  type InstallationPlan,
  stackForEnvironment,
  validateInstallationConfig,
  workersDevPlan,
} from './installation-plan';
import { digest } from './security';

/**
 * A deployment's API Worker is `<prefix>-api-<stack>` (sync-wrangler-config.ts). Both halves may
 * contain hyphens, so a stack such as `blue-api-prod` makes the name readable in more than one
 * way; the deployment's own assets bucket decides which reading is real (findDeployment).
 */
const WORKER_SEPARATOR = '-api-';

type Deployment = Omit<AdoptionTarget, 'stateBucket'>;

/**
 * Plans taking over the SAM already running at the chosen domain. The deployment is found by
 * its API Worker route and assets bucket; its state bucket by the name the owner gives
 * (`stateBucket`, for a deployment that set `PULUMI_STATE_BUCKET`), or else by the names the
 * fork workflow and the installer use. Anything that does not identify exactly one existing
 * deployment is reported as a conflict, so the owner can never approve a takeover of something
 * else.
 */
export async function previewAdoption(token: string, input: unknown): Promise<InstallationPlan> {
  const requested = validateInstallationConfig({ ...(input as object), adoption: undefined });
  const { stateBucket: named } = input as { stateBucket?: unknown };
  // Checked before it is used in a request path.
  if (!validStateBucketName(named)) throw new Error('Invalid deploy-state bucket name');
  await assertActiveZone(token, requested);
  const workersDev = await workersDevPlan(token, requested.accountId);
  const conflicts: InstallationPlan['conflicts'] = [];
  const found = await findDeployment(token, requested);
  let adoption: AdoptionTarget | undefined;
  if (typeof found === 'string') conflicts.push({ name: found, type: 'adoption' });
  else {
    const candidates = named
      ? [named]
      : // The fork workflow's default first (workflow-resource-names.mjs), then the installer's.
        [`${found.prefix}-pulumi-state`, `${found.prefix}-pulumi-state-${found.environment}`];
    const stateBucket = await firstBucket(token, requested.accountId, candidates);
    if (!stateBucket)
      conflicts.push({
        name: `no deploy state bucket named ${candidates.join(' or ')}`,
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

/** Whether this is a state bucket an owner may name; empty means the conventional names. */
export function validStateBucketName(value: unknown): value is string | undefined {
  return (
    value === undefined || value === '' || (typeof value === 'string' && BUCKET_NAME.test(value))
  );
}

/** Every way a Worker name reads as `<prefix>-api-<stack>`. */
function deploymentReadings(script: string): Deployment[] {
  const readings: Deployment[] = [];
  for (
    let at = script.indexOf(WORKER_SEPARATOR);
    at !== -1;
    at = script.indexOf(WORKER_SEPARATOR, at + 1)
  ) {
    const prefix = script.slice(0, at);
    const stack = script.slice(at + WORKER_SEPARATOR.length);
    if (DEPLOYMENT_PREFIX.test(prefix) && DEPLOYMENT_STACK.test(stack))
      readings.push({ prefix, environment: stack === 'prod' ? 'production' : stack });
  }
  return readings;
}

function assetsBucket(target: Deployment): string {
  return `${target.prefix}-${stackForEnvironment(target.environment)}-assets`;
}

async function findDeployment(
  token: string,
  { accountId, zoneId, baseDomain }: { accountId: string; zoneId: string; baseDomain: string }
): Promise<Deployment | string> {
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
  const readings = typeof script === 'string' ? deploymentReadings(script) : [];
  if (!readings.length) return `api.${baseDomain} is not served by a SAM API Worker`;
  // Every deployment owns `<prefix>-<stack>-assets` (infra/resources/storage.ts), so the
  // reading whose assets bucket exists is the deployment; the name alone cannot say.
  const real: Deployment[] = [];
  for (const reading of readings)
    if (await firstBucket(token, accountId, [assetsBucket(reading)])) real.push(reading);
  if (real.length > 1) return `the Worker ${script} could be more than one SAM deployment`;
  return real[0] ?? `no SAM assets bucket named ${readings.map(assetsBucket).join(' or ')}`;
}

/** The first of these R2 buckets that exists in the account. */
async function firstBucket(
  token: string,
  accountId: string,
  names: string[]
): Promise<string | undefined> {
  for (const name of names) {
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
  return [adoption.stateBucket, assetsBucket(adoption), maintenanceBucket];
}
