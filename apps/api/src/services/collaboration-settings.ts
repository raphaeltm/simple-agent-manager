/**
 * Collaboration tunables (shared sessions and comment mentions). Admin-editable runtime
 * settings with typed code defaults (policy 9017df94), read through the cached registry.
 */
import { DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';
import {
  type AdminSettingName,
  DEFAULT_COMMENT_MENTIONS_MAX,
  DEFAULT_SESSION_ACCESS_MAX_GRANTS,
} from './admin-settings-registry';

// resolveAdminSetting degrades to the registry default on a store outage, so a read never
// blocks commenting or sharing; the guard only narrows the value's type.
async function integerSetting(env: Env, name: AdminSettingName, fallback: number) {
  const value = await resolveAdminSetting(env, name);
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function getSessionAccessMaxGrants(env: Env): Promise<number> {
  return integerSetting(
    env,
    'collaboration.sessionAccessMaxGrants',
    DEFAULT_SESSION_ACCESS_MAX_GRANTS
  );
}

export function getCommentMentionsMax(env: Env): Promise<number> {
  return integerSetting(env, 'collaboration.commentMentionsMax', DEFAULT_COMMENT_MENTIONS_MAX);
}

export async function getCommentNotificationWindowMs(env: Env): Promise<number> {
  const seconds = await integerSetting(
    env,
    'collaboration.commentNotificationWindowSeconds',
    DEFAULT_COMMENT_NOTIFICATION_WINDOW_MS / 1000
  );
  return seconds * 1000;
}
