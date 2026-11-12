/**
 * Provider selection by configuration: `SAM_KEY_PROVIDER` names one implementation, and each
 * reads its own settings (key reference, credential file, endpoint) from the same environment.
 *
 * AWS KMS is not implemented in this spike; what it needs is written down in the PR (design
 * notes, "AWS KMS"): an instance-role credential from IMDSv2, SigV4-signed
 * `TrentService.Encrypt`/`Decrypt` with `EncryptionContext`, which fits this interface unchanged.
 */
import type { KeyProvider } from './provider.ts';
import { KeyProviderError } from './provider.ts';
import { createAzureKeyVaultProvider } from './provider-azure-kv.ts';
import { createFileProvider } from './provider-file.ts';
import { createGcpKmsProvider } from './provider-gcp-kms.ts';
import { createTransitProvider } from './provider-transit.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const KEY_PROVIDERS: Readonly<Record<string, (env: Env) => KeyProvider>> = {
  file: createFileProvider,
  transit: createTransitProvider,
  'gcp-kms': createGcpKmsProvider,
  'azure-kv': createAzureKeyVaultProvider,
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
