export function parseCacheTtlSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function parseCacheTtlMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}
