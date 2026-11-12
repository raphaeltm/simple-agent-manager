/**
 * In-process fakes of the cloud key services, for the conformance suite. Each fake does the real
 * cryptography (AES-256-GCM for Cloud KMS symmetric keys, RSA-OAEP-256 for Key Vault), checks the
 * bearer token its fake metadata endpoint issued, and answers in the service's documented REST
 * shape. They prove our request shape and error mapping against the documented API, not against
 * the real service.
 */
import {
  constants,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeKeyService {
  host: string;
  token: string;
  /** Requests are answered 403 while true (an IAM grant removed). */
  setDenied(denied: boolean): void;
  close(): Promise<void>;
}

export interface FakeKeyServiceOptions {
  /** Only these keys exist (Cloud KMS names, Key Vault key names); others answer 404. */
  existingKeys?: readonly string[];
  /** The project id the fake GCE metadata server reports. */
  gcpProject?: string;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startFakeKeyServices(
  options: FakeKeyServiceOptions = {}
): Promise<FakeKeyService> {
  const exists = (name: string) => !options.existingKeys || options.existingKeys.includes(name);
  const token = randomBytes(16).toString('hex');
  let denied = false;
  const gcpKeys = new Map<string, Buffer>();
  const azureKeys = new Map<string, Map<string, { publicKey: KeyObject; privateKey: KeyObject }>>();

  function azureVersion(name: string, version?: string) {
    let versions = azureKeys.get(name);
    if (!versions) {
      versions = new Map();
      azureKeys.set(name, versions);
    }
    if (version) return { version, pair: versions.get(version) };
    const latest = [...versions.keys()].at(-1);
    if (latest) return { version: latest, pair: versions.get(latest) };
    const created = randomBytes(16).toString('hex');
    versions.set(created, generateKeyPairSync('rsa', { modulusLength: 2048 }));
    return { version: created, pair: versions.get(created) };
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const url = new URL(request.url ?? '/', 'http://fake');
      // Platform identity (platform-probe.ts): each answers only with its own request marker.
      if (url.pathname === '/computeMetadata/v1/project/project-id') {
        if (request.headers['metadata-flavor'] !== 'Google') return send(403, {});
        response.writeHead(200, { 'content-type': 'text/plain', 'metadata-flavor': 'Google' });
        return response.end(options.gcpProject ?? 'sam-test-project');
      }
      if (url.pathname === '/metadata/instance/compute') {
        if (request.headers.metadata !== 'true') return send(400, {});
        return send(200, {
          vmId: '00000000-0000-4000-8000-000000000001',
          location: 'westeurope',
          subscriptionId: '00000000-0000-4000-8000-0000000000aa',
        });
      }
      // Token endpoints (GCE metadata, Azure IMDS).
      if (url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
        if (request.headers['metadata-flavor'] !== 'Google') return send(403, {});
        return send(200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
      }
      if (url.pathname === '/metadata/identity/oauth2/token') {
        if (request.headers.metadata !== 'true') return send(400, {});
        return send(200, { access_token: token, expires_in: '3599', token_type: 'Bearer' });
      }
      if (request.headers.authorization !== `Bearer ${token}`) return send(401, {});
      if (denied) return send(403, { error: { code: 'Forbidden' } });
      const input = await body(request);

      // Cloud KMS: POST /v1/projects/.../cryptoKeys/K:encrypt|decrypt
      const gcp = /^\/v1\/(projects\/[^:]+):(encrypt|decrypt)$/.exec(url.pathname);
      if (gcp) {
        const [, name = '', op] = gcp;
        if (!exists(name)) return send(404, { error: { status: 'NOT_FOUND' } });
        let key = gcpKeys.get(name);
        if (!key) {
          key = randomBytes(32);
          gcpKeys.set(name, key);
        }
        const aad = Buffer.from(String(input.additionalAuthenticatedData ?? ''), 'base64');
        if (op === 'encrypt') {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          cipher.setAAD(aad);
          const ct = Buffer.concat([
            cipher.update(Buffer.from(String(input.plaintext), 'base64')),
            cipher.final(),
          ]);
          return send(200, {
            name,
            ciphertext: Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64'),
          });
        }
        try {
          const blob = Buffer.from(String(input.ciphertext), 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
          decipher.setAAD(aad);
          decipher.setAuthTag(blob.subarray(blob.length - 16));
          const pt = Buffer.concat([
            decipher.update(blob.subarray(12, blob.length - 16)),
            decipher.final(),
          ]);
          return send(200, { plaintext: pt.toString('base64') });
        } catch {
          return send(400, { error: { status: 'INVALID_ARGUMENT', message: 'Decryption failed' } });
        }
      }

      // Key Vault: POST /keys/{name}/wrapkey, POST /keys/{name}/{version}/unwrapkey
      const az = /^\/keys\/([A-Za-z0-9-]+)(?:\/([0-9a-f]+))?\/(wrapkey|unwrapkey)$/.exec(
        url.pathname
      );
      if (az && url.searchParams.get('api-version') === '7.4' && input.alg === 'RSA-OAEP-256') {
        const [, name = '', version, op] = az;
        if (!exists(name)) return send(404, { error: { code: 'KeyNotFound' } });
        const resolved = azureVersion(name, version);
        if (!resolved.pair) return send(404, { error: { code: 'KeyNotFound' } });
        const kid = `http://${request.headers.host}/keys/${name}/${resolved.version}`;
        const value = Buffer.from(String(input.value), 'base64url');
        const options = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };
        try {
          const out =
            op === 'wrapkey'
              ? publicEncrypt({ key: resolved.pair.publicKey, ...options }, value)
              : privateDecrypt({ key: resolved.pair.privateKey, ...options }, value);
          return send(200, { kid, value: out.toString('base64url') });
        } catch {
          return send(400, { error: { code: 'BadParameter' } });
        }
      }
      return send(404, {});
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    host: `127.0.0.1:${port}`,
    token,
    setDenied: (value) => {
      denied = value;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
