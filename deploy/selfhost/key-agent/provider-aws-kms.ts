/**
 * AWS KMS `Encrypt` / `Decrypt` (symmetric key), signed with SigV4 (aws-sigv4.ts).
 *
 * Credentials, in order:
 * - a stored access key (`SAM_AWS_CREDENTIALS_FILE`, JSON `{"AccessKeyId","SecretAccessKey"}`),
 *   for a host with no AWS identity; scope its policy to kms:Encrypt and kms:Decrypt on this key;
 * - otherwise the EC2 instance role through IMDSv2 (`PUT /latest/api/token`, then
 *   `/latest/meta-data/iam/security-credentials/<role>`): nothing is stored on the box.
 *
 * The context is bound as `EncryptionContext` {"sam:context-sha256": <hex>}: KMS authenticates
 * it and records it in CloudTrail, so a hash keeps the log short and free of bundle details.
 *
 * Tested against a fake of the documented JSON API (scripts/selfhost/aws-kms-fake.ts) and the
 * signer against AWS's published SigV4 vectors. It has NOT run against real AWS.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { type AwsCredentials, signRequest } from './aws-sigv4.ts';
import {
  b64,
  DEFAULT_KEY_SERVICE_TIMEOUT_MS,
  field,
  type KeyProvider,
  KeyProviderError,
  type KeyProviderErrorKind,
  requireSetting,
  unb64,
} from './provider.ts';

/** Key id, key ARN, alias name or alias ARN (KMS accepts all four as `KeyId`). */
const KEY_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32}|alias\/[A-Za-z0-9/_-]{1,250}|arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(?:key\/[A-Za-z0-9-]+|alias\/[A-Za-z0-9/_-]+))$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const ROLE = /^[\w+=,.@-]{1,128}$/;
/** Refresh instance-role credentials this long before they expire. */
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000;
const IMDS_TOKEN_TTL_SECONDS = 21_600;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** KMS error types by the recovery they need (provider.ts KeyProviderErrorKind). */
const ERROR_KINDS: Readonly<Record<string, KeyProviderErrorKind>> = {
  AccessDeniedException: 'denied',
  UnrecognizedClientException: 'denied',
  InvalidClientTokenId: 'denied',
  DisabledException: 'denied',
  KMSInvalidStateException: 'denied',
  InvalidCiphertextException: 'invalid',
  IncorrectKeyException: 'invalid',
  ValidationException: 'invalid',
  SerializationException: 'invalid',
  NotFoundException: 'config',
  InvalidKeyUsageException: 'config',
  InvalidSignatureException: 'config',
  IncompleteSignature: 'config',
  KMSInternalException: 'unavailable',
  DependencyTimeoutException: 'unavailable',
  KeyUnavailableException: 'unavailable',
  ThrottlingException: 'unavailable',
  LimitExceededException: 'unavailable',
};

function errorType(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const raw = field(parsed, '__type') ?? field(parsed, 'code');
    return typeof raw === 'string' ? (raw.split('#').pop() ?? '') : '';
  } catch {
    return '';
  }
}

function regionOf(keyId: string, configured: string | undefined): string {
  const fromArn = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):/.exec(keyId)?.[1];
  const region = configured?.trim() || fromArn || '';
  if (!REGION.test(region)) {
    throw new KeyProviderError('config', 'SAM_AWS_KMS_REGION is required unless the key is an ARN');
  }
  if (fromArn && fromArn !== region) {
    throw new KeyProviderError('config', 'SAM_AWS_KMS_REGION differs from the key ARN region');
  }
  return region;
}

async function readBounded(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > MAX_RESPONSE_BYTES ? '' : text;
}

export function createAwsKmsProvider(
  env: Readonly<Record<string, string | undefined>>
): KeyProvider {
  const keyId = requireSetting(env, 'SAM_AWS_KMS_KEY_ID');
  if (!KEY_ID.test(keyId)) {
    throw new KeyProviderError(
      'config',
      'SAM_AWS_KMS_KEY_ID must be a key id, key ARN, alias/<name> or alias ARN'
    );
  }
  const region = regionOf(keyId, env.SAM_AWS_KMS_REGION);
  const endpoint = new URL(
    env.SAM_AWS_KMS_ENDPOINT?.trim() || `https://kms.${region}.amazonaws.com/`
  );
  if (
    endpoint.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  ) {
    throw new KeyProviderError(
      'config',
      'SAM_AWS_KMS_ENDPOINT must be https:// unless on loopback'
    );
  }
  const imds = `http://${env.SAM_AWS_IMDS_HOST?.trim() || '169.254.169.254'}`;
  const credentialsFile = env.SAM_AWS_CREDENTIALS_FILE?.trim();
  const keyRef = keyId.startsWith('arn:') ? keyId : `${region}/${keyId}`;
  const service = `aws-kms ${keyRef}`;
  let cached: { credentials: AwsCredentials; expiresAt: number } | null = null;

  async function imdsCall(path: string, init: RequestInit, what: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${imds}${path}`, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(DEFAULT_KEY_SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new KeyProviderError('unavailable', `aws imds: ${what} failed (${reason})`);
    }
    const text = await readBounded(response);
    if (response.status === 404) {
      throw new KeyProviderError('config', `aws imds: ${what}: no instance role is attached`);
    }
    if (!response.ok) {
      throw new KeyProviderError('unavailable', `aws imds: ${what}: HTTP ${response.status}`);
    }
    return text;
  }

  async function credentials(): Promise<AwsCredentials> {
    if (credentialsFile) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(credentialsFile, 'utf8')) as unknown;
      } catch {
        throw new KeyProviderError(
          'config',
          `cannot read the AWS credentials file ${credentialsFile}`
        );
      }
      const accessKeyId = field(parsed, 'AccessKeyId');
      const secretAccessKey = field(parsed, 'SecretAccessKey');
      if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
        throw new KeyProviderError(
          'config',
          `${credentialsFile} needs AccessKeyId and SecretAccessKey`
        );
      }
      return { accessKeyId, secretAccessKey };
    }
    if (cached && Date.now() < cached.expiresAt) return cached.credentials;
    const token = (
      await imdsCall(
        '/latest/api/token',
        {
          method: 'PUT',
          headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(IMDS_TOKEN_TTL_SECONDS) },
        },
        'IMDSv2 token'
      )
    ).trim();
    const headers = { 'X-aws-ec2-metadata-token': token };
    const role = (
      await imdsCall('/latest/meta-data/iam/security-credentials/', { headers }, 'role name')
    )
      .split('\n')[0]
      ?.trim();
    if (!role || !ROLE.test(role)) {
      throw new KeyProviderError('config', 'aws imds: no instance role is attached');
    }
    let document: unknown;
    try {
      document = JSON.parse(
        await imdsCall(
          `/latest/meta-data/iam/security-credentials/${role}`,
          { headers },
          'role credentials'
        )
      ) as unknown;
    } catch (error) {
      if (error instanceof KeyProviderError) throw error;
      throw new KeyProviderError('unavailable', 'aws imds: role credentials are not JSON');
    }
    const accessKeyId = field(document, 'AccessKeyId');
    const secretAccessKey = field(document, 'SecretAccessKey');
    const sessionToken = field(document, 'Token');
    const expiration = Date.parse(String(field(document, 'Expiration') ?? ''));
    if (
      typeof accessKeyId !== 'string' ||
      typeof secretAccessKey !== 'string' ||
      typeof sessionToken !== 'string'
    ) {
      throw new KeyProviderError('unavailable', 'aws imds: role credentials are incomplete');
    }
    const result = { accessKeyId, secretAccessKey, sessionToken };
    cached = {
      credentials: result,
      expiresAt: Number.isFinite(expiration) ? expiration - CREDENTIAL_REFRESH_MARGIN_MS : 0,
    };
    return result;
  }

  async function call(
    target: 'Encrypt' | 'Decrypt',
    payload: Record<string, unknown>,
    retried = false
  ): Promise<unknown> {
    const body = JSON.stringify(payload);
    const signed = signRequest({
      method: 'POST',
      url: endpoint,
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `TrentService.${target}`,
      },
      body,
      region,
      service: 'kms',
      credentials: await credentials(),
      now: new Date(),
    });
    // fetch sets Host from the URL itself (the same `host[:port]` that was signed).
    const headers = Object.fromEntries(
      Object.entries(signed.headers).filter(([name]) => name !== 'host')
    );
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(DEFAULT_KEY_SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'error';
      throw new KeyProviderError('unavailable', `${service}: request failed (${reason})`);
    }
    const text = await readBounded(response);
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new KeyProviderError('unavailable', `${service}: response is not JSON`);
      }
    }
    // Error bodies name the type; their messages are never repeated (they can echo the request).
    const type = errorType(text);
    if (type === 'ExpiredTokenException' && !retried && !credentialsFile) {
      cached = null;
      return await call(target, payload, true);
    }
    const kind: KeyProviderErrorKind =
      ERROR_KINDS[type] ??
      (response.status === 401 || response.status === 403
        ? 'denied'
        : response.status === 429 || response.status >= 500 || type === 'ExpiredTokenException'
          ? 'unavailable'
          : 'invalid');
    if (kind === 'denied') cached = null;
    throw new KeyProviderError(kind, `${service}: ${type || `HTTP ${response.status}`}`);
  }

  const encryptionContext = (context: Uint8Array) => ({
    'sam:context-sha256': createHash('sha256').update(context).digest('hex'),
  });

  return {
    name: 'aws-kms',
    keyRef,
    bindsContext: true,
    async wrap(dataKey, context) {
      const result = await call('Encrypt', {
        KeyId: keyId,
        Plaintext: b64(dataKey),
        EncryptionContext: encryptionContext(context),
      });
      return unb64(field(result, 'CiphertextBlob'), `${service}: CiphertextBlob`);
    },
    async unwrap(wrapped, context) {
      const result = await call('Decrypt', {
        KeyId: keyId,
        CiphertextBlob: b64(wrapped),
        EncryptionContext: encryptionContext(context),
      });
      return unb64(field(result, 'Plaintext'), `${service}: Plaintext`);
    },
  };
}
