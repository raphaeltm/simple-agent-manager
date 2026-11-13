/**
 * Previous AES keys during a platform-key rotation on a self-hosted box.
 *
 * `pnpm selfhost:secrets rotate encryption-key` deploys the Worker with a new ENCRYPTION_KEY and
 * the old one as ENCRYPTION_KEY_PREVIOUS, then re-encrypts every stored row under the new key.
 * While it runs, rows still under the old key must stay readable: `decrypt` and `decryptFile`
 * try the key they are given first and, only when that fails, the previous key registered for
 * it here. New ciphertext is always written under the current key.
 *
 * Explicit entry point: only the self-host celld wrapper (`selfhost/runtime-secrets.ts`) calls
 * `setPreviousEncryptionKeys`, from the runtime secrets of the deployed bundle. Nothing else
 * registers a key, so on Cloudflare the map is always empty and both functions behave exactly
 * as before. A Cloudflare operator who wants the same overlap would register the pair from their
 * own Worker entry the same way.
 *
 * Keeping the old key readable for longer costs nothing in security: it only lets the Worker
 * read ciphertext an attacker holding the old key could already read.
 */

let previousByCurrent: ReadonlyMap<string, string> = new Map();

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
  return previousByCurrent.get(currentKey);
}
