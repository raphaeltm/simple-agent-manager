import type { ProviderConfig } from '@simple-agent-manager/providers';
import {
  type CredentialProvider,
  DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { buildProviderConfig } from './provider-credential-codecs';

/**
 * The Infomaniak boot volume size admins set (`infomaniak.bootVolumeGb`). The read shares the
 * per-isolate admin settings cache, so it costs no D1 round trip when the cache is warm. During a
 * settings outage `resolveAdminSetting` returns the registered default, so provider resolution
 * never fails on this setting.
 *
 * The settings module is loaded on first use, as `gcp-provider-factory.ts` does: a static import
 * would pull the settings registry into every module that resolves a provider.
 */
export async function resolveInfomaniakBootVolumeGb(env: Env): Promise<number> {
  const { resolveAdminSetting } = await import('./admin-settings-resolution');
  const value = await resolveAdminSetting(env, 'infomaniak.bootVolumeGb');
  return typeof value === 'number' ? value : DEFAULT_INFOMANIAK_BOOT_VOLUME_GB;
}

/**
 * `buildProviderConfig` plus the runtime settings that size what the provider creates. Every
 * non-GCP provider the API builds for provisioning or for the catalog goes through here, so the
 * disk a pool candidate advertises is the disk the VM gets. Only Infomaniak reads a setting today.
 */
export async function buildProviderConfigForEnv(
  provider: Exclude<CredentialProvider, 'gcp'>,
  decryptedToken: string,
  env: Env
): Promise<ProviderConfig> {
  const infomaniakBootVolumeGb =
    provider === 'infomaniak' ? await resolveInfomaniakBootVolumeGb(env) : undefined;
  return buildProviderConfig(provider, decryptedToken, env, { infomaniakBootVolumeGb });
}
