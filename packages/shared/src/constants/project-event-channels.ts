export const DEFAULT_PROJECT_EVENT_CHANNEL_MAX_CHANNELS = 128;
export const DEFAULT_PROJECT_EVENT_CHANNEL_MESSAGE_MAX_BYTES = 4096;
export const DEFAULT_PROJECT_EVENT_CHANNEL_NAME_MAX_BYTES = 64;
export const DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_WINDOW_MS = 60_000;
export const DEFAULT_PROJECT_EVENT_CHANNEL_PUBLISH_MAX_PER_WINDOW = 120;
export const DEFAULT_PROJECT_EVENT_CHANNEL_CURSOR_TTL_MS = 3_600_000;
export const DEFAULT_PROJECT_EVENT_CHANNEL_CATALOG_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * SAM-managed agent message channels (`agent-dm.*`). Disabled by default: the
 * feature is a preliminary draft and has not been validated on staging.
 * Override: AGENT_MESSAGE_CHANNELS_ENABLED.
 */
export const DEFAULT_AGENT_MESSAGE_CHANNELS_ENABLED = false;
/**
 * Pair channels have their own catalog cap so agent messaging cannot exhaust the
 * shared channel capacity used by coordination channels.
 * Override: AGENT_MESSAGE_CHANNEL_MAX_CHANNELS.
 */
export const DEFAULT_AGENT_MESSAGE_CHANNEL_MAX_CHANNELS = 1024;
/**
 * A managed subscription this close to the end of its wake lifetime is replaced
 * before the next publication when it owes no pending wake.
 * Override: AGENT_MESSAGE_SUBSCRIPTION_ROTATION_GRACE_MS.
 */
export const DEFAULT_AGENT_MESSAGE_SUBSCRIPTION_ROTATION_GRACE_MS = 5 * 60 * 1000;
