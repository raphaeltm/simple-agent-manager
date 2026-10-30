import type { Env } from '../env';
import { resolveAdminSettingDetailsMany } from './admin-settings';
import type { ResolvedPlatformConfig, ResolvedPlatformValue } from './platform-config-types';

export interface ResolvedLoginOAuthConfig {
  github: Pick<ResolvedPlatformConfig['github'], 'clientId' | 'clientSecret'>;
  google: ResolvedPlatformConfig['google'];
  gitlab: ResolvedPlatformConfig['gitlab'];
}

type Setting = Awaited<ReturnType<typeof resolveAdminSettingDetailsMany>>[number];
function loginValue(setting: Setting | undefined): ResolvedPlatformValue {
  if (!setting) throw new Error('Login settings are unavailable.');
  return {
    value: typeof setting.value === 'string' ? setting.value : null,
    source:
      setting.source === 'database'
        ? 'runtime'
        : setting.source === 'default'
          ? 'unset'
          : 'environment',
    updatedAt: setting.updatedAt,
    updatedBy: setting.updatedBy,
  };
}

/** Session bootstrap needs login clients, never App/webhook/feedback or infrastructure config. */
export async function resolveLoginOAuthConfig(env: Env): Promise<ResolvedLoginOAuthConfig> {
  const [githubId, githubSecret, googleId, googleSecret, gitlabHost, gitlabId, gitlabSecret] =
    await resolveAdminSettingDetailsMany(env, [
      'integration.github.clientId',
      'integration.github.clientSecret',
      'integration.google.clientId',
      'integration.google.clientSecret',
      'integration.gitlab.host',
      'integration.gitlab.clientId',
      'integration.gitlab.clientSecret',
    ]);
  return {
    github: { clientId: loginValue(githubId), clientSecret: loginValue(githubSecret) },
    google: { clientId: loginValue(googleId), clientSecret: loginValue(googleSecret) },
    gitlab: {
      host: loginValue(gitlabHost),
      clientId: loginValue(gitlabId),
      clientSecret: loginValue(gitlabSecret),
    },
  };
}
