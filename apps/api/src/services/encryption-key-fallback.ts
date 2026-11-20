/**
 * The self-host platform-key rotation scope: previous AES keys, and whether the rotation's
 * other `*_PREVIOUS` settings (JWT, BetterAuth) are honoured at all.
 *
 * `pnpm selfhost:secrets rotate encryption-key` deploys the Worker with a new ENCRYPTION_KEY and
 * the old one as ENCRYPTION_KEY_PREVIOUS, then re-encrypts every stored row under the new key.
 * While it runs, rows still under the old key must stay readable: `decrypt` and `decryptFile`
 * try the key they are given first and, only when that fails, the previous key registered for
 * it here. New ciphertext is always written under the current key.
 *
 * Explicit entry point: only the self-host celld wrapper (`selfhost/runtime-secrets.ts`
 * `registerRotationKeys`) calls `enableSelfHostRotationScope` and `setPreviousEncryptionKeys`,
 * from the runtime secrets of the deployed bundle. The Cloudflare entry (`src/index.ts`) never
 * imports that module, so on Cloudflare the scope stays off and the map stays empty: every
 * rotation variable (`*_PREVIOUS`, `JWT_KEY_ID`, `BETTER_AUTH_SECRET_VERSION`) is ignored even
 * when set as a Worker var or secret, and behaviour is exactly the pre-rotation behaviour
 * (tests/unit/services/rotation-scope-cloudflare.test.ts).
 *
 * Keeping the old key readable for longer costs nothing in security: it only lets the Worker
 * read ciphertext an attacker holding the old key could already read.
 */

let previousByCurrent: ReadonlyMap<string, string> = new Map();
let selfHostRotationScope = false;

/**
 * Honour the rotation variables in this isolate. Called only by the self-host runtime wrapper;
 * one-way, because an isolate never moves between a celld box and Cloudflare.
 */
export function enableSelfHostRotationScope(): void {
  selfHostRotationScope = true;
}

/** Whether rotation variables are honoured: true only inside the self-host celld wrapper. */
export function selfHostRotationScopeEnabled(): boolean {
  return selfHostRotationScope;
}

/** Replaces the registered pairs: current key (base64) -> previous key (base64). */
export function setPreviousEncryptionKeys(pairs: ReadonlyMap<string, string>): void {
  const next = new Map<string, string>();
  for (const [current, previous] of pairs) {
    if (current && previous && current !== previous) next.set(current, previous);
  }
  previousByCurrent = next;
}

/** The previous key registered for `currentKey`, if a rotation is in progress for it. */
export function previousEncryptionKeyFor(currentKey: string): string | undefined {
  if (!selfHostRotationScope) return undefined;
  return previousByCurrent.get(currentKey);
}

/** Test seam: back to the Cloudflare state (scope off, no pairs). */
export function resetSelfHostRotationScopeForTests(): void {
  selfHostRotationScope = false;
  previousByCurrent = new Map();
}
