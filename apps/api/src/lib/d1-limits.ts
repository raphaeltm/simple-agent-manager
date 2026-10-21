/** Cloudflare D1/SQLite protocol ceiling for bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** Split values into runs of at most `size`, e.g. to keep an `IN (...)` list under the limit. */
export function chunk<T>(values: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += step) {
    chunks.push(values.slice(index, index + step));
  }
  return chunks;
}
