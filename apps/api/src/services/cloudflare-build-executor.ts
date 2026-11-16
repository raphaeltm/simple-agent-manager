import {
  dispatchCloudflareBuild as dispatch,
  drainCloudflareBuilds as drain,
} from '@simple-agent-manager/app-deployment';

import { createCloudflareBuildPorts } from '../app-deployment-ports/cloudflare-builder';
import type { Env } from '../env';
export const dispatchCloudflareBuild = (env: Env, jobId: string) =>
  dispatch(env.DATABASE, createCloudflareBuildPorts(env), jobId);
export const drainCloudflareBuilds = (env: Env) =>
  drain(env.DATABASE, createCloudflareBuildPorts(env));
