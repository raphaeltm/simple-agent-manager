export const BASE_RECONNECT_DELAY = 1000;
export const MAX_RECONNECT_DELAY = 30000;
export const MAX_RETRIES = 10;
export const PING_INTERVAL_MS = parseInt(import.meta.env.VITE_WS_PING_INTERVAL_MS || '30000');
export const PONG_TIMEOUT_MS = parseInt(import.meta.env.VITE_WS_PONG_TIMEOUT_MS || '10000');
