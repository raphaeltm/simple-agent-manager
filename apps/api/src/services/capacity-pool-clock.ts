let lastCapacityPoolTimestampMs = 0;

export function nextCapacityPoolTimestamp(): string {
  const current = Date.now();
  const next = Math.max(current, lastCapacityPoolTimestampMs + 1);
  lastCapacityPoolTimestampMs = next;
  return new Date(next).toISOString();
}
