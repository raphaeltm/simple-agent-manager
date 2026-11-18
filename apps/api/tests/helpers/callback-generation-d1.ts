/**
 * A D1 binding with no workspace or node rows, for tests that exercise callback-token
 * signing and claim checks in isolation. `verifyCallbackToken` reads the credential
 * generation of the row a token names; with no row it defers to the sinks, so these
 * tests keep testing only the claims. Tests about generation revocation must use a
 * real SQL engine instead (`tests/unit/services/callback-credential-generation.test.ts`).
 */
export const D1_WITHOUT_CALLBACK_ROWS = {
  prepare: () => ({ bind: () => ({ first: async () => null }) }),
} as unknown as D1Database;
