/** Worker wiring for the package's isolated, background-only shadow probe. */
import {
  type BuildContextInterpolation,
  type CreateDeploymentPublishJobInput,
  scheduleBuildContextShadow as schedule,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { createBuildContextCollectionPorts } from './build-context-collection';

export function scheduleBuildContextShadow(
  env: Env,
  input: CreateDeploymentPublishJobInput,
  interpolation: BuildContextInterpolation,
  execCtx?: { waitUntil(promise: Promise<unknown>): void }
) {
  return schedule(env, createBuildContextCollectionPorts(env), input, interpolation, execCtx);
}
