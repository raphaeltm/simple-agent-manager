/**
 * This device's clock compared with the API's, measured from the `serverTime` the API sends with
 * shared-session access summaries. Access countdowns read it so "ends in 5 min" matches the
 * server, which is what decides: it reads its own clock on every request and refuses an expired
 * grant whatever a browser shows. Display only.
 */
let offsetMs = 0;

/** Record the server's clock from a response that just arrived. */
export function recordServerTime(serverTime: unknown, receivedAt: number = Date.now()): void {
  if (typeof serverTime === 'number' && Number.isFinite(serverTime)) {
    offsetMs = serverTime - receivedAt;
  }
}

/** Now, by the server's clock. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}

/** A server timestamp on this device's clock, for showing "at 3:42 PM". */
export function toDeviceTime(serverMs: number): number {
  return serverMs - offsetMs;
}
