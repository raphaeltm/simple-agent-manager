import type { Env } from './types';

export function isProjectEventWakeEnabled(env: Env): boolean {
  const raw = env.PROJECT_EVENT_WAKE_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return raw === 'true';
}
