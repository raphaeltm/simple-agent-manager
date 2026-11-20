/**
 * Reverse-tunnel defaults and bounds, free of imports so the box deploy script
 * (scripts/selfhost/box-settings.ts) resolves frps's settings from the same values the Worker
 * enforces (config.ts) instead of a copy of them.
 */
const REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS = 30;

export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_START = 20000;
export const DEFAULT_REVERSE_TUNNEL_PORT_RANGE_END = 29999;
export const MAX_REVERSE_TUNNEL_PORT_RANGE_SIZE = 20000;

export const DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 90;
export const MIN_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS =
  2 * REVERSE_TUNNEL_HEARTBEAT_INTERVAL_SECONDS;
export const MAX_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS = 3600;
/** A released port is not reissued before this many heartbeat timeouts. */
export const REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE = 2;
export const DEFAULT_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS =
  REVERSE_TUNNEL_PORT_REUSE_HEARTBEAT_MULTIPLE * DEFAULT_REVERSE_TUNNEL_HEARTBEAT_TIMEOUT_SECONDS;
export const MAX_REVERSE_TUNNEL_PORT_REUSE_MIN_AGE_SECONDS = 86_400;
