import type { Env } from './types';

export function isProjectEventWakeEnabled(env: Env): boolean {
  return env.PROJECT_EVENT_WAKE_ENABLED === 'true';
}
