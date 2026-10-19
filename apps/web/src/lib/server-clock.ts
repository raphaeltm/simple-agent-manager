/**
 * This device's clock compared with the API's, measured from the `serverTime` the API sends with
 * shared-session access summaries. Access countdowns read it so "ends in 5 min" matches the
 * server, which is what decides: it reads its own clock on every request and refuses an expired
 * grant whatever a browser shows. Display only.
 */
let offsetMs = 0;
let latestServerTime = Number.NEGATIVE_INFINITY;

/**
 * Record the server's clock from a response that just arrived. The server's clock never runs
 * backwards, so a reading older than one already seen (a response served from a cache, or one
 * that arrived out of order) is ignored rather than dragging the countdowns back.
 */
export function recordServerTime(serverTime: unknown, receivedAt: number = Date.now()): void {
  if (typeof serverTime !== 'number' || !Number.isFinite(serverTime)) return;
  if (serverTime < latestServerTime) return;
  latestServerTime = serverTime;
  offsetMs = serverTime - receivedAt;
}

/** Forget every reading. For tests, which move the device clock around. */
export function resetServerClock(): void {
  offsetMs = 0;
  latestServerTime = Number.NEGATIVE_INFINITY;
}

/** Now, by the server's clock. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** A server timestamp on this device's clock, for showing "at 3:42 PM". */
export function toDeviceTime(serverMs: number): number {
  return serverMs - offsetMs;
}
