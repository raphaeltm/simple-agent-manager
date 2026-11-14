import {
  type GcpBootDiskPolicy,
  type GcpCatalogOptions,
  GcpProvider,
  type GcpTokenProvider,
  normalizeGcpBootDiskPolicy,
} from '@simple-agent-manager/providers';
import type { GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';

/**
 * The boot disk sizing admins set (`gcpCatalog.bootDiskGbPerVcpu`, `gcpCatalog.bootDiskMinGb`).
 * Both reads share the per-isolate admin settings cache, so this costs no D1 round trip when the
 * cache is warm. During a settings outage `resolveAdminSetting` returns the registered defaults,
 * so provider resolution never fails on these settings.
 *
 * The settings module is loaded on first use, as `provider-credentials.ts` loads `gcp-sts`: a
 * static import would pull the settings registry into every module that resolves a provider.
 */
export async function resolveGcpBootDiskPolicy(env: Env): Promise<GcpBootDiskPolicy> {
  const { resolveAdminSetting } = await import('./admin-settings-resolution');
  const [gbPerVcpu, minGb] = await Promise.all([
    resolveAdminSetting(env, 'gcpCatalog.bootDiskGbPerVcpu'),
    resolveAdminSetting(env, 'gcpCatalog.bootDiskMinGb'),
  ]);
  return normalizeGcpBootDiskPolicy({
    gbPerVcpu: typeof gbPerVcpu === 'number' ? gbPerVcpu : undefined,
    minGb: typeof minGb === 'number' ? minGb : undefined,
  });
}

/**
 * Every GCP provider the API builds goes through here, so provisioning and the catalog use the
 * same boot disk policy: the disk a pool candidate advertises is the disk the VM gets.
 *
 * Constructs `GcpProvider` directly rather than through `createProvider`: tests of the teardown
 * and provisioning paths substitute the `GcpProvider` export, which `createProvider` (resolved
 * inside the providers package) would bypass.
 */
export async function createGcpProviderForEnv(
  env: Env,
  credential: Pick<GcpCredential, 'gcpProjectId' | 'defaultZone'>,
  tokenProvider: GcpTokenProvider,
  catalog?: GcpCatalogOptions
): Promise<GcpProvider> {
  return new GcpProvider(
    credential.gcpProjectId,
    tokenProvider,
    credential.defaultZone,
    undefined,
    undefined,
    await resolveGcpBootDiskPolicy(env),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    catalog
  );
}
