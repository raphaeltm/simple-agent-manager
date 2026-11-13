/** Worker settings adapter for the canonical artifact/context retention sweeps. */
import { runScheduledComposeImageArtifactCleanup as run } from '@simple-agent-manager/app-deployment/scheduled';

import type { Env } from '../env';
import { resolveAdminSetting } from '../services/admin-settings';
export type { ComposeImageArtifactCleanupStats } from '@simple-agent-manager/app-deployment/scheduled';
export {
  COMPOSE_IMAGE_ARTIFACT_PREFIX,
  runComposeImageArtifactCleanup,
} from '@simple-agent-manager/app-deployment/scheduled';
export function runScheduledComposeImageArtifactCleanup(env: Env, now: Date = new Date()) {
  return run(env, { resolveSetting: (name) => resolveAdminSetting(env, name) }, now);
}
