/**
 * In-process fake of EC2 IMDSv2 and the AWS KMS JSON API (`TrentService.Encrypt` / `Decrypt`),
 * for the conformance suite and the automatic-choice tests. It does real cryptography (AES-256-GCM
 * with the encryption context as AAD), verifies every request's SigV4 signature, credential and
 * session token, and answers errors in KMS's documented shape (`{"__type": ...}`, HTTP 400).
 *
 * It verifies signatures with the agent's own signer; aws-sigv4.test.ts checks that signer
 * against AWS's published vectors, which is what keeps this fake from merely agreeing with it.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { signRequest } from '../../deploy/selfhost/key-agent/aws-sigv4.ts';

export const FAKE_AWS_REGION = 'eu-west-1';
export const FAKE_AWS_ACCOUNT = '123456789012';
const ROLE = 'sam-box-role';

export interface FakeAws {
  host: string;
  /** The instance role's credentials, to assert they never appear in output. */
  secrets: () => string[];
  /** Answer AccessDeniedException while true (the key policy or IAM grant removed). */
  setDenied(denied: boolean): void;
  /** Requests KMS accepted, by target. */
  calls: string[];
  close(): Promise<void>;
}

export interface FakeAwsOptions {
  /** Key ids and aliases (`alias/x`) that exist; aliases map to a key of the same name. */
  existingKeys?: readonly string[];
  /** Instance role credentials expire this many ms after issue (default one hour). */
  credentialTtlMs?: number;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function contextAad(context: unknown): Buffer {
  const record = typeof context === 'object' && context !== null ? context : {};
  const sorted = Object.entries(record as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : 1
  );
  return Buffer.from(JSON.stringify(sorted));
}

export async function startFakeAws(options: FakeAwsOptions = {}): Promise<FakeAws> {
  const imdsTokens = new Set<string>();
  const creds = {
    accessKeyId: `ASIA${randomBytes(8).toString('hex').toUpperCase()}`,
    secretAccessKey: randomBytes(30).toString('base64'),
    sessionToken: randomBytes(48).toString('base64'),
  };
  const keys = new Map<string, Buffer>();
  const calls: string[] = [];
  let denied = false;

  const resolveKey = (keyId: string): string | null => {
    const name = keyId.replace(/^arn:aws:kms:[^:]+:\d+:/, '').replace(/^key\//, '');
    if (options.existingKeys && !options.existingKeys.includes(name)) return null;
    return name.replace(/^alias\//, '');
  };
  const keyMaterial = (id: string): Buffer => {
    let key = keys.get(id);
    if (!key) {
      key = randomBytes(32);
      keys.set(id, key);
    }
    return key;
  };

  function send(response: ServerResponse, status: number, body: unknown, type = 'json'): void {
    response.writeHead(status, {
      'content-type': type === 'json' ? 'application/x-amz-json-1.1' : 'text/plain',
    });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  const kmsError = (response: ServerResponse, type: string, status = 400) =>
    send(response, status, { __type: type, message: 'fake' });

  function verifySignature(request: IncomingMessage, body: string, url: URL): string | null {
    const auth = String(request.headers.authorization ?? '');
    const match =
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/kms\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
        auth
      );
    if (!match) return 'IncompleteSignature';
    const [, accessKey, , region, signedHeaders = '', signature = ''] = match;
    if (accessKey !== creds.accessKeyId) return 'UnrecognizedClientException';
    if (request.headers['x-amz-security-token'] !== creds.sessionToken) {
      return 'UnrecognizedClientException';
    }
    const amzDate = String(request.headers['x-amz-date'] ?? '');
    const when = Date.parse(
      amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    );
    if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 5 * 60_000) {
      return 'InvalidSignatureException';
    }
    const headers: Record<string, string> = {};
    for (const name of signedHeaders.split(';')) {
      if (name === 'x-amz-date' || name === 'x-amz-security-token') continue;
      headers[name] = String(request.headers[name] ?? '');
    }
    const expected = signRequest({
      method: request.method ?? 'POST',
      url,
      headers,
      body,
      region: region ?? '',
      service: 'kms',
      credentials: creds,
      now: new Date(when),
    });
    const ok =
      expected.headers.authorization?.endsWith(
        `SignedHeaders=${signedHeaders}, Signature=${signature}`
      ) && timingSafeEqual(Buffer.from(expected.signature), Buffer.from(signature));
    return ok ? null : 'InvalidSignatureException';
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const body = await readBody(request);
      // EC2 IMDSv2.
      if (url.pathname === '/latest/api/token') {
        if (request.method !== 'PUT' || !request.headers['x-aws-ec2-metadata-token-ttl-seconds']) {
          return send(response, 400, '', 'text');
        }
        const token = randomBytes(24).toString('base64');
        imdsTokens.add(token);
        return send(response, 200, token, 'text');
      }
      if (url.pathname.startsWith('/latest/')) {
        // IMDSv1 (no token) is refused, as on an instance that requires IMDSv2.
        if (!imdsTokens.has(String(request.headers['x-aws-ec2-metadata-token'] ?? ''))) {
          return send(response, 401, '', 'text');
        }
        if (url.pathname === '/latest/dynamic/instance-identity/document') {
          return send(response, 200, {
            region: FAKE_AWS_REGION,
            accountId: FAKE_AWS_ACCOUNT,
            instanceId: 'i-0123456789abcdef0',
          });
        }
        if (url.pathname === '/latest/meta-data/iam/security-credentials/') {
          return send(response, 200, ROLE, 'text');
        }
        if (url.pathname === `/latest/meta-data/iam/security-credentials/${ROLE}`) {
          return send(response, 200, {
            Code: 'Success',
            Type: 'AWS-HMAC',
            AccessKeyId: creds.accessKeyId,
            SecretAccessKey: creds.secretAccessKey,
            Token: creds.sessionToken,
            Expiration: new Date(Date.now() + (options.credentialTtlMs ?? 3_600_000)).toISOString(),
          });
        }
        return send(response, 404, '', 'text');
      }
      // KMS.
      if (request.method !== 'POST' || url.pathname !== '/')
        return kmsError(response, 'UnknownOperationException');
      if (request.headers['content-type'] !== 'application/x-amz-json-1.1') {
        return kmsError(response, 'SerializationException');
      }
      const signatureError = verifySignature(request, body, url);
      if (signatureError) return kmsError(response, signatureError, 400);
      if (denied) return kmsError(response, 'AccessDeniedException');
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body) as unknown;
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        input = parsed as Record<string, unknown>;
      } catch {
        return kmsError(response, 'SerializationException');
      }
      const target = String(request.headers['x-amz-target'] ?? '');
      const keyId = resolveKey(String(input.KeyId ?? ''));
      if (!keyId) return kmsError(response, 'NotFoundException');
      const aad = contextAad(input.EncryptionContext);
      calls.push(target);
      if (target === 'TrentService.Encrypt') {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', keyMaterial(keyId), iv);
        cipher.setAAD(aad);
        const ct = Buffer.concat([
          cipher.update(Buffer.from(String(input.Plaintext ?? ''), 'base64')),
          cipher.final(),
        ]);
        // Blob layout (opaque to callers, like the real one): key id, iv, ciphertext, tag.
        const id = Buffer.from(keyId);
        const blob = Buffer.concat([Buffer.of(id.length), id, iv, ct, cipher.getAuthTag()]);
        return send(response, 200, {
          CiphertextBlob: blob.toString('base64'),
          KeyId: `arn:aws:kms:${FAKE_AWS_REGION}:${FAKE_AWS_ACCOUNT}:key/${keyId}`,
        });
      }
      if (target === 'TrentService.Decrypt') {
        const blob = Buffer.from(String(input.CiphertextBlob ?? ''), 'base64');
        const idLength = blob[0] ?? 0;
        const blobKey = blob.subarray(1, 1 + idLength).toString('utf8');
        if (blob.length < 1 + idLength + 12 + 16 || !keys.has(blobKey)) {
          return kmsError(response, 'InvalidCiphertextException');
        }
        if (blobKey !== keyId) return kmsError(response, 'IncorrectKeyException');
        try {
          const rest = blob.subarray(1 + idLength);
          const decipher = createDecipheriv(
            'aes-256-gcm',
            keyMaterial(keyId),
            rest.subarray(0, 12)
          );
          decipher.setAAD(aad);
          decipher.setAuthTag(rest.subarray(rest.length - 16));
          const pt = Buffer.concat([
            decipher.update(rest.subarray(12, rest.length - 16)),
            decipher.final(),
          ]);
          return send(response, 200, { Plaintext: pt.toString('base64'), KeyId: keyId });
        } catch {
          return kmsError(response, 'InvalidCiphertextException');
        }
      }
      return kmsError(response, 'UnknownOperationException');
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    secrets: () => [creds.secretAccessKey, creds.sessionToken],
    setDenied: (value) => {
      denied = value;
    },
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
