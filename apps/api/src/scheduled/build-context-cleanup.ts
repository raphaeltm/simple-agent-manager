/** Worker settings adapter for the canonical context retention sweep. */
import { runBuildContextCleanup as run } from '@simple-agent-manager/app-deployment/scheduled';

import type { Env } from '../env';
import { resolveAdminSetting } from '../services/admin-settings';
export function runBuildContextCleanup(env: Env, now: Date = new Date()) {
  return run(env, { resolveSetting: (name) => resolveAdminSetting(env, name) }, now);
}
