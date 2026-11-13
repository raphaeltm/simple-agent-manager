import type { ProjectDataEnv } from '../durable-objects/project-data/types';
import type { Env } from '../env';

/**
 * ProjectData code runs inside the Worker (client, scheduled jobs) or inside the
 * ProjectData Durable Object, and both receive the Worker's full env object; the
 * narrow `ProjectDataEnv` type only limits what ProjectData itself may read. The
 * port implementations widen it here, at this one documented boundary
 * (`.claude/rules/51`: a DO receives a structural superset of its declared env).
 */
export function workerEnv(env: ProjectDataEnv): Env {
  return env as Env;
}
