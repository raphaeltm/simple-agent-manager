import { resolveAdminSettingDetailsMany } from '../../services/admin-settings-resolution';
import {
  REPOSITORY_POLICY_DEFAULTS,
  type RepositoryPolicyKey,
  type RepositorySettingName,
} from '../../services/artifacts/settings';
import type { HostedGitEnv } from './env';
import { DEFAULT_HOSTED_GIT_LIMITS, type HostedGitLimits } from './limits';

export async function resolveHostedGitLimits(env: HostedGitEnv): Promise<HostedGitLimits> {
  const keys = Object.keys(REPOSITORY_POLICY_DEFAULTS) as RepositoryPolicyKey[];
  const settings = await resolveAdminSettingDetailsMany(
    env,
    keys.map((key) => `repositories.${key}` as RepositorySettingName)
  );
  const result = { ...DEFAULT_HOSTED_GIT_LIMITS };
  for (const [index, key] of keys.entries()) {
    const setting = settings[index];
    if (!setting || typeof setting.value !== 'number')
      throw new Error('Repository policy is unavailable');
    result[key] = setting.value;
  }
  return result;
}
