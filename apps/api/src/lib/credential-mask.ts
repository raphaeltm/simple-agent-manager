/**
 * Mask a plaintext credential for display in API responses and UI.
 *
 * For short credentials, returning the last 4 characters of `slice(-4)` can leak
 * the full value (e.g., a 3-character credential becomes entirely visible). For
 * long credentials, the last 4 characters provide enough recognizability without
 * revealing the secret.
 *
 * Rules:
 *  - `plaintext.length <= 8`  → `'...[set]'` (no sensitive content)
 *  - `plaintext.length >  8`  → `'...${last4}'`
 *
 * Always pass the *decrypted plaintext* (not the raw request body or the
 * ciphertext) so masks are consistent across save/list/update code paths.
 */
export function maskCredential(plaintext: string | null | undefined): string {
  if (!plaintext || plaintext.length <= 8) {
    return '...[set]';
  }
  return `...${plaintext.slice(-4)}`;
}
