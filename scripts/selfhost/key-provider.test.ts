/**
 * Every key provider against the same conformance suite (key-provider-conformance.ts): the file
 * provider for real, Cloud KMS and Key Vault against in-process fakes of their REST APIs
 * (key-provider-fakes.ts). OpenBao transit runs the same suite in a container in the live suite
 * (live/key-agent-transit.live.test.ts).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAzureKeyVaultProvider } from '../../deploy/selfhost/key-agent/provider-azure-kv.ts';
import { createFileProvider, generateFileKek } from '../../deploy/selfhost/key-agent/provider-file.ts';
import { createGcpKmsProvider } from '../../deploy/selfhost/key-agent/provider-gcp-kms.ts';
import { KeyProviderError } from '../../deploy/selfhost/key-agent/provider.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { describeKeyProviderConformance } from './key-provider-conformance';
import { type FakeKeyService, startFakeKeyServices } from './key-provider-fakes';

const dir = mkdtempSync(join(tmpdir(), 'sam-kek-'));
function kekFile(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, generateFileKek(), { mode: 0o600 });
  return path;
}
const kekA = kekFile('a');
const kekB = kekFile('b');

describeKeyProviderConformance('file', {
  provider: () => createFileProvider({ SAM_KEY_FILE: kekA }),
  otherKey: () => createFileProvider({ SAM_KEY_FILE: kekB }),
});

// The fakes start before the suites register their tests; providers are built lazily per test.
let fake: FakeKeyService;
const CLOSED = '127.0.0.1:9';
beforeAll(async () => {
  fake = await startFakeKeyServices();
});
afterAll(async () => {
  await fake.close();
});

const gcpKey = (k: string) => `projects/sam-test-project/locations/global/keyRings/sam/cryptoKeys/${k}`;
const gcp = (key: string, host = () => fake.host) => () =>
  createGcpKmsProvider({
    SAM_GCP_KMS_KEY: gcpKey(key),
    SAM_GCP_KMS_ENDPOINT: `http://${host()}`,
    SAM_GCE_METADATA_HOST: host(),
  });

describeKeyProviderConformance('gcp-kms (fake Cloud KMS + metadata server)', {
  provider: gcp('box'),
  otherKey: gcp('other'),
  unreachable: gcp('box', () => CLOSED),
  denied: () => {
    fake.setDenied(true);
    return { provider: gcp('box')(), restore: () => fake.setDenied(false) };
  },
  credentials: () => [fake.token],
});

const azure = (key: string, host = () => fake.host) => () =>
  createAzureKeyVaultProvider({
    SAM_AZURE_KEY_VAULT_URL: `http://${host()}`,
    SAM_AZURE_KEY_NAME: key,
    SAM_AZURE_IMDS_HOST: host(),
    SAM_AZURE_ALLOW_HTTP_FOR_TESTS: '1',
  });

describeKeyProviderConformance('azure-kv (fake Key Vault + IMDS)', {
  provider: azure('box'),
  otherKey: azure('other'),
  unreachable: azure('box', () => CLOSED),
  denied: () => {
    fake.setDenied(true);
    return { provider: azure('box')(), restore: () => fake.setDenied(false) };
  },
  credentials: () => [fake.token],
});

describe('provider selection and configuration', () => {
  it('refuses an unknown provider name and lists the known ones', () => {
    expect(() => createKeyProvider({ SAM_KEY_PROVIDER: 'aws-kms' })).toThrow(/file, transit, gcp-kms, azure-kv/);
    expect(() => createKeyProvider({ SAM_KEY_PROVIDER: 'constructor' })).toThrow(KeyProviderError);
  });

  it('file: refuses a key file readable by others, and one that is not 32 bytes', () => {
    const loose = join(dir, 'loose');
    writeFileSync(loose, generateFileKek(), { mode: 0o644 });
    expect(() => createFileProvider({ SAM_KEY_FILE: loose })).toThrow(/group or others/);
    const short = join(dir, 'short');
    writeFileSync(short, Buffer.alloc(16).toString('base64'), { mode: 0o600 });
    expect(() => createFileProvider({ SAM_KEY_FILE: short })).toThrow(/32 bytes/);
  });

  it('transit: refuses plain HTTP to anything but loopback, and a missing credential', () => {
    expect(() =>
      createKeyProvider({ SAM_KEY_PROVIDER: 'transit', SAM_TRANSIT_ADDR: 'http://vault.example', SAM_TRANSIT_KEY: 'k', SAM_TRANSIT_TOKEN_FILE: '/x' })
    ).toThrow(/https/);
    expect(() =>
      createKeyProvider({ SAM_KEY_PROVIDER: 'transit', SAM_TRANSIT_ADDR: 'https://vault.example', SAM_TRANSIT_KEY: 'k' })
    ).toThrow(/ROLE_ID|TOKEN_FILE/);
  });

  it('gcp-kms: refuses a key that is not a full resource name', () => {
    expect(() => createGcpKmsProvider({ SAM_GCP_KMS_KEY: 'sam-box' })).toThrow(/projects\/P/);
  });
});
