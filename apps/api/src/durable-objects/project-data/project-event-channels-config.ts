import {
  DEFAULT_PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS,
  DEFAULT_PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS,
  DEFAULT_PROJECT_EVENT_CHANNEL_MAX_CHANNELS,
  DEFAULT_PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES,
  DEFAULT_PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES,
  DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW,
  DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS,
} from '@simple-agent-manager/shared';

import { ProjectEventValidationError } from './project-events-contracts';
import { resolveProjectEventLimits } from './project-events-limits';
import { normalizeText } from './project-events-values';

export interface ProjectEventChannelEnv {
  PROJECT_EVENT_CHANNEL_MAX_CHANNELS?: string;
  PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES?: string;
  PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES?: string;
  PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS?: string;
  PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW?: string;
  PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS?: string;
  PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS?: string;
}

function positive(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ProjectEventValidationError(`${field} must be a positive safe integer`);
  }
  return number;
}

export function channelLimits(env: ProjectEventChannelEnv) {
  return {
    maxChannels: positive(
      env.PROJECT_EVENT_CHANNEL_MAX_CHANNELS,
      DEFAULT_PROJECT_EVENT_CHANNEL_MAX_CHANNELS,
      'PROJECT_EVENT_CHANNEL_MAX_CHANNELS'
    ),
    messageBytes: positive(
      env.PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES,
      'PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES'
    ),
    nameBytes: positive(
      env.PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES,
      DEFAULT_PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES,
      'PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES'
    ),
    publishWindowMs: positive(
      env.PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS,
      DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS,
      'PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS'
    ),
    publishMax: positive(
      env.PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW,
      DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW,
      'PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW'
    ),
    cursorTtlMs: positive(
      env.PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS,
      DEFAULT_PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS,
      'PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS'
    ),
    catalogIdleTtlMs: positive(
      env.PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS,
      DEFAULT_PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS,
      'PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS'
    ),
  };
}

export function channelName(value: string, env: ProjectEventChannelEnv): string {
  const name = normalizeText(value, 'channel', channelLimits(env).nameBytes);
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) {
    throw new ProjectEventValidationError(
      'channel must contain lowercase letters, digits, dots, underscores or hyphens'
    );
  }
  return name;
}

/** Page sizes share the canonical event list budget. */
export { resolveProjectEventLimits };
