/**
 * Provider selection by configuration: `SAM_KEY_PROVIDER` names one implementation, and each
 * reads its own settings (key reference, credential file, endpoint) from the same environment.
 * `pnpm selfhost:deploy --init` writes that environment for the provider it chose
 * (scripts/selfhost/key-choice.ts).
 */
import type { KeyProvider } from './provider.ts';
import { KeyProviderError } from './provider.ts';
import { createAwsKmsProvider } from './provider-aws-kms.ts';
import { createAzureKeyVaultProvider } from './provider-azure-kv.ts';
import { createFileProvider } from './provider-file.ts';
import { createGcpKmsProvider } from './provider-gcp-kms.ts';
import { createTransitProvider } from './provider-transit.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `SAM_KEY_PROVIDER` value that keeps the pre-sealing behaviour: every Worker secret is a deploy
 * var, stored in plaintext in the fleet bucket for every deployed version. Temporary. The agent
 * still runs (compose starts it on every box) and refuses every secrets request.
 */
export const LEGACY_KEY_PROVIDER = 'legacy-plaintext';

export const KEY_PROVIDERS: Readonly<Record<string, (env: Env) => KeyProvider>> = {
  file: createFileProvider,
  transit: createTransitProvider,
  'gcp-kms': createGcpKmsProvider,
  'azure-kv': createAzureKeyVaultProvider,
  'aws-kms': createAwsKmsProvider,
};

export function createKeyProvider(env: Env): KeyProvider {
  const name = env.SAM_KEY_PROVIDER?.trim() ?? '';
  const factory = Object.hasOwn(KEY_PROVIDERS, name) ? KEY_PROVIDERS[name] : undefined;
  if (!factory) {
    throw new KeyProviderError(
      'config',
      `SAM_KEY_PROVIDER must be one of ${Object.keys(KEY_PROVIDERS).join(', ')}`
    );
  }
  return factory(env);
}
