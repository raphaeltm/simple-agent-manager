/**
 * Installation identity, and the marker that installation keys left Pulumi state.
 *
 * Installation keys (ENCRYPTION_KEY, the JWT and VAPID pairs, the deploy and preview signing keys)
 * are no longer Pulumi resources. They are created once, straight into the API Worker's secrets,
 * and nothing reads them back (`scripts/deploy/installation-keys.ts`). Existing deployments keep
 * the values their Worker already holds; `scripts/deploy/retire-key-resources.ts` removed the old
 * key resources from state without touching a value. Do not add a key, secret or token resource
 * here: a `random.RandomId`'s resource id is its raw bytes, stored in plain text, and any
 * generated secret in state is a copy of it outside Cloudflare (`infra/__tests__/secrets.test.ts`).
 */

import * as random from '@pulumi/random';

/**
 * Stable exact-installation identity for ownership labels on external resources.
 * It is intentionally non-secret, but protected because rotation would make an
 * existing fleet safely unattributable to destructive reconciliation.
 */
const installationIdResource = new random.RandomId(
  'installation-id',
  { byteLength: 16 },
  { protect: true }
);

/**
 * Not a secret: one random byte that marks this stack as having retired its key resources. A
 * release from before the retirement does not declare it, so that release's `pulumi up` fails on
 * this protected resource and stops before its deploy could write new Pulumi-generated keys over
 * the Worker's (`RETIREMENT_MARKER` in `scripts/deploy/retire-key-resources.ts`).
 */
new random.RandomId('installation-keys-retired', { byteLength: 1 }, { protect: true });

export const installationId = installationIdResource.hex;
