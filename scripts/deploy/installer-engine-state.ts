/** The engine's `state-backend` phase: the Pulumi state bucket, login and stack selection. */
import type { InstallerEngineConfig } from './installer-engine-contract.js';

export interface StateBackendSteps {
  config: InstallerEngineConfig;
  apiBase: string;
  stateBucket: string;
  stack: string;
  prefix: string;
  token: string;
  request(url: string, init?: RequestInit): Promise<Response>;
  createBucket(): Promise<unknown>;
  prepareLegacyCiBackend(): Promise<unknown>;
  login(url: string): Promise<unknown>;
  pulumi(...args: string[]): Promise<string>;
  configureWorkersDev(): Promise<void>;
}

/** Ensures the state bucket and stack exist, selects the stack and writes its identity config. */
export async function prepareStateBackend(steps: StateBackendSteps): Promise<void> {
  const { config: c, stateBucket, stack } = steps;
  const bucketResponse = await steps.request(
    `${steps.apiBase}/accounts/${c.accountId}/r2/buckets/${stateBucket}`,
    { headers: { Authorization: `Bearer ${steps.token}` } }
  );
  if (bucketResponse.status === 404) await steps.createBucket();
  else if (!bucketResponse.ok) throw new Error('State bucket inspection failed');
  if (c.profile === 'legacy-ci') await steps.prepareLegacyCiBackend();
  await steps.login(
    `s3://${stateBucket}?endpoint=https://${c.accountId}.r2.cloudflarestorage.com&region=auto`
  );
  const stackData: unknown = JSON.parse(await steps.pulumi('stack', 'ls', '--json'));
  if (
    !Array.isArray(stackData) ||
    stackData.some(
      (entry: unknown) =>
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { name?: unknown }).name !== 'string'
    )
  )
    throw new Error('Invalid Pulumi stack listing');
  const stacks = stackData as Array<{ name: string }>;
  if (stacks.some((entry) => entry.name === stack || entry.name.endsWith(`/${stack}`)))
    await steps.pulumi('stack', 'select', stack);
  else await steps.pulumi('stack', 'init', stack);
  await steps.configureWorkersDev();
  for (const [key, value] of Object.entries({
    cloudflareAccountId: c.accountId,
    cloudflareZoneId: c.zoneId,
    baseDomain: c.baseDomain,
    zoneName: c.zoneName,
    resourcePrefix: steps.prefix,
  })) {
    await steps.pulumi('config', 'set', key, value);
  }
}
