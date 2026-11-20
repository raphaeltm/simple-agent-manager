/**
 * AWS Signature Version 4 for one request, header form (the `Authorization` header), as the
 * AWS KMS provider needs it. Checked against AWS's published signing test suite
 * (scripts/selfhost/testdata/aws-sigv4, run by scripts/selfhost/aws-sigv4.test.ts).
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 *
 * Runs under Node's type stripping, no dependencies.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (instance role, STS). */
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to send and sign; `host` is added from the URL when missing. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
  /** Adds `x-amz-content-sha256` (S3 style); KMS does not need it. */
  signBody?: boolean;
}

export interface Signed {
  /** Every header to send, including `authorization`, `x-amz-date` and the session token. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding: everything but unreserved characters is percent-encoded, upper hex. */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalPath(pathname: string): string {
  // Normalized (no empty or dot segments; URL already resolved dots), each segment encoded once
  // from its decoded form, which is what non-S3 services expect.
  const segments = pathname.split('/').map((s) => uriEncode(decodeURIComponent(s)));
  const joined = segments.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([k, v]) => [uriEncode(k), uriEncode(v)] as const
  );
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function signRequest(input: SignInput): Signed {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  headers.host ??= input.url.host;
  headers['x-amz-date'] = date;
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }
  const payloadHash = sha256Hex(input.body);
  if (input.signBody) headers['x-amz-content-sha256'] = payloadHash;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/ +/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url.pathname),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
