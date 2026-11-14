import {
  type GcpBootDiskPolicy,
  type GcpCatalogOptions,
  GcpProvider,
  type GcpTokenProvider,
  normalizeGcpBootDiskPolicy,
} from '@simple-agent-manager/providers';
import type { GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings-resolution';

/**
 * The boot disk sizing admins set (`gcpCatalog.bootDiskGbPerVcpu`, `gcpCatalog.bootDiskMinGb`).
 * Both reads share the per-isolate admin settings cache, so this costs no D1 round trip when the
 * cache is warm.
 */
export async function resolveGcpBootDiskPolicy(env: Env): Promise<GcpBootDiskPolicy> {
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
 * Every `GcpProvider` the API builds goes through here, so provisioning and the catalog use the
 * same boot disk policy: the disk a pool candidate advertises is the disk the VM gets.
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
