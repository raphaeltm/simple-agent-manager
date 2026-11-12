/**
 * Every key provider against the same conformance suite (key-provider-conformance.ts): the file
 * provider for real, Cloud KMS and Key Vault against in-process fakes of their REST APIs
 * (key-provider-fakes.ts), AWS KMS against a fake of IMDSv2 and the KMS JSON API that verifies
 * SigV4 (aws-kms-fake.ts). OpenBao transit runs the same suite in a container in the live suite
 * (live/key-agent-transit.live.test.ts).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KeyProviderError } from '../../deploy/selfhost/key-agent/provider.ts';
import { createAwsKmsProvider } from '../../deploy/selfhost/key-agent/provider-aws-kms.ts';
import { createAzureKeyVaultProvider } from '../../deploy/selfhost/key-agent/provider-azure-kv.ts';
import {
  createFileProvider,
  generateFileKek,
} from '../../deploy/selfhost/key-agent/provider-file.ts';
import { createGcpKmsProvider } from '../../deploy/selfhost/key-agent/provider-gcp-kms.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { FAKE_AWS_REGION, type FakeAws, startFakeAws } from './aws-kms-fake';
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
let aws: FakeAws;
const CLOSED = '127.0.0.1:9';
beforeAll(async () => {
  fake = await startFakeKeyServices();
  aws = await startFakeAws();
});
afterAll(async () => {
  await fake.close();
  await aws.close();
});

const gcpKey = (k: string) =>
  `projects/sam-test-project/locations/global/keyRings/sam/cryptoKeys/${k}`;
const gcp =
  (key: string, host = () => fake.host) =>
  () =>
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

const azure =
  (key: string, host = () => fake.host) =>
  () =>
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

const awsKms =
  (key: string, host = () => aws.host, extra: Record<string, string> = {}) =>
  () =>
    createAwsKmsProvider({
      SAM_AWS_KMS_KEY_ID: key,
      SAM_AWS_KMS_REGION: FAKE_AWS_REGION,
      SAM_AWS_KMS_ENDPOINT: `http://${host()}/`,
      SAM_AWS_IMDS_HOST: host(),
      ...extra,
    });

describeKeyProviderConformance('aws-kms (fake KMS JSON API with SigV4 + IMDSv2)', {
  provider: awsKms('alias/sam-box'),
  otherKey: awsKms('alias/sam-other'),
  unreachable: awsKms('alias/sam-box', () => CLOSED),
  denied: () => {
    aws.setDenied(true);
    return { provider: awsKms('alias/sam-box')(), restore: () => aws.setDenied(false) };
  },
  credentials: () => aws.secrets(),
});

describe('aws-kms specifics', () => {
  it('signs with the instance role and never puts its credentials in errors or keyRef', async () => {
    const provider = awsKms('alias/sam-box')();
    expect(provider.keyRef).toBe(`${FAKE_AWS_REGION}/alias/sam-box`);
    aws.setDenied(true);
    try {
      const error = await provider
        .wrap(new Uint8Array(32), new Uint8Array(4))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeyProviderError);
      expect((error as KeyProviderError).kind).toBe('denied');
      for (const secret of aws.secrets()) expect(String(error)).not.toContain(secret);
    } finally {
      aws.setDenied(false);
    }
  });

  it('a key that does not exist is a configuration error (NotFoundException)', async () => {
    const strict = await startFakeAws({ existingKeys: ['alias/sam-box'] });
    try {
      const error = await awsKms('alias/missing', () => strict.host)()
        .wrap(new Uint8Array(32), new Uint8Array(4))
        .catch((e: unknown) => e);
      expect((error as KeyProviderError).kind).toBe('config');
    } finally {
      await strict.close();
    }
  });

  it('uses a stored, narrowly scoped access key when SAM_AWS_CREDENTIALS_FILE is set', async () => {
    const file = join(dir, 'aws-credentials');
    writeFileSync(file, JSON.stringify({ AccessKeyId: 'AKIAWRONG', SecretAccessKey: 'x' }), {
      mode: 0o600,
    });
    // The fake knows only the instance role: a stored key it did not issue is refused (denied).
    const error = await awsKms('alias/sam-box', () => aws.host, {
      SAM_AWS_CREDENTIALS_FILE: file,
    })()
      .wrap(new Uint8Array(32), new Uint8Array(4))
      .catch((e: unknown) => e);
    expect((error as KeyProviderError).kind).toBe('denied');
  });

  it('refreshes instance-role credentials when they expire', async () => {
    const short = await startFakeAws({ credentialTtlMs: 1 });
    try {
      const provider = awsKms('alias/sam-box', () => short.host)();
      const context = new Uint8Array(Buffer.from('ctx'));
      const blob = await provider.wrap(new Uint8Array(32), context);
      expect((await provider.unwrap(blob, context)).length).toBe(32);
    } finally {
      await short.close();
    }
  });

  it('refuses a missing region, a region that contradicts the ARN, and plain HTTP off loopback', () => {
    expect(() => createAwsKmsProvider({ SAM_AWS_KMS_KEY_ID: 'alias/x' })).toThrow(/REGION/);
    expect(() =>
      createAwsKmsProvider({
        SAM_AWS_KMS_KEY_ID: `arn:aws:kms:us-east-1:123456789012:key/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
        SAM_AWS_KMS_REGION: 'eu-west-1',
      })
    ).toThrow(/differs/);
    expect(() =>
      createAwsKmsProvider({
        SAM_AWS_KMS_KEY_ID: 'alias/x',
        SAM_AWS_KMS_REGION: 'eu-west-1',
        SAM_AWS_KMS_ENDPOINT: 'http://kms.example.com/',
      })
    ).toThrow(/https/);
    expect(() =>
      createAwsKmsProvider({ SAM_AWS_KMS_KEY_ID: 'not a key', SAM_AWS_KMS_REGION: 'eu-west-1' })
    ).toThrow(/SAM_AWS_KMS_KEY_ID/);
  });
});

describe('provider selection and configuration', () => {
  it('refuses an unknown provider name and lists the known ones', () => {
    expect(() => createKeyProvider({ SAM_KEY_PROVIDER: 'aws' })).toThrow(
      /file, transit, gcp-kms, azure-kv, aws-kms/
    );
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
      createKeyProvider({
        SAM_KEY_PROVIDER: 'transit',
        SAM_TRANSIT_ADDR: 'http://vault.example',
        SAM_TRANSIT_KEY: 'k',
        SAM_TRANSIT_TOKEN_FILE: '/x',
      })
    ).toThrow(/https/);
    expect(() =>
      createKeyProvider({
        SAM_KEY_PROVIDER: 'transit',
        SAM_TRANSIT_ADDR: 'https://vault.example',
        SAM_TRANSIT_KEY: 'k',
      })
    ).toThrow(/ROLE_ID|TOKEN_FILE/);
  });

  it('gcp-kms: refuses a key that is not a full resource name', () => {
    expect(() => createGcpKmsProvider({ SAM_GCP_KMS_KEY: 'sam-box' })).toThrow(/projects\/P/);
  });
});
