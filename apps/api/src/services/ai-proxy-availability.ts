import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings-resolution';
import { AI_PROXY_DIRECT_UPSTREAM_SETTING } from './ai-proxy-settings';
import { resolveAiGatewayId } from './platform-capabilities';

/** Call only after authentication at HTTP entry points: absence must not leak config. */
export async function isAiProxyEnabled(env: Env): Promise<boolean> {
  if (env.AI_PROXY_ENABLED === 'false') return false;
  if (resolveAiGatewayId(env)) return true;
  return (await resolveAdminSetting(env, AI_PROXY_DIRECT_UPSTREAM_SETTING)) === true;
}
