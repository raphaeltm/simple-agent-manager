import {
  createProvider,
  type GcpBootDiskPolicy,
  type GcpCatalogOptions,
  type GcpTokenProvider,
  normalizeGcpBootDiskPolicy,
  type Provider,
} from '@simple-agent-manager/providers';
import type { GcpCredential } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings-resolution';

/**
 * The boot disk sizing admins set (`gcpCatalog.bootDiskGbPerVcpu`, `gcpCatalog.bootDiskMinGb`).
 * Both reads share the per-isolate admin settings cache, so this costs no D1 round trip when the
 * cache is warm. During a settings outage `resolveAdminSetting` returns the registered defaults,
 * so provider resolution never fails on these settings.
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
 * Every GCP provider the API builds goes through here, so provisioning and the catalog use the
 * same boot disk policy: the disk a pool candidate advertises is the disk the VM gets.
 */
export async function createGcpProviderForEnv(
  env: Env,
  credential: Pick<GcpCredential, 'gcpProjectId' | 'defaultZone'>,
  tokenProvider: GcpTokenProvider,
  catalog?: GcpCatalogOptions
): Promise<Provider> {
  return createProvider({
    provider: 'gcp',
    projectId: credential.gcpProjectId,
    tokenProvider,
    defaultZone: credential.defaultZone,
    bootDiskPolicy: await resolveGcpBootDiskPolicy(env),
    ...(catalog ? { catalog } : {}),
  });
}
