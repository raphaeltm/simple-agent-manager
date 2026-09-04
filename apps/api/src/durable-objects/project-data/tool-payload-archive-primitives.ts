/**
 * Shared low-level primitives for the ProjectData tool-payload archive path.
 *
 * These were previously copied into `tool-payload-archive-r2.ts`,
 * `tool-payload-archive-read.ts` and `tool-payload-cleanup-manifest.ts`. Every
 * archive/manifest write, read-back and hash verification must agree on the exact
 * digest encoding and the exact timeout semantics, so there is one implementation
 * (`.claude/rules/24`, `.claude/rules/59`).
 */

/** Lowercase hex encoding — the on-disk/on-R2 representation for every archive digest. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `bytes` as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * Races `operation` against `timeoutMs`, always clearing the timer.
 *
 * The `operation.catch(() => undefined)` guard attaches a no-op rejection handler
 * so a losing operation cannot surface as an unhandled rejection after the race
 * has already settled on the timeout.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  operation.catch(() => undefined);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
