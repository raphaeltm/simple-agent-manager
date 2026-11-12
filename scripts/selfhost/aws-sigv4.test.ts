/**
 * The key agent's SigV4 signer against AWS's own published test vectors (testdata/aws-sigv4,
 * copied from awslabs/aws-c-auth). The AWS KMS fake verifies signatures with this same signer, so
 * these vectors are what proves the signer, and through it the fake, against AWS itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { signRequest } from '../../deploy/selfhost/key-agent/aws-sigv4.ts';

const DIR = join(import.meta.dirname, 'testdata/aws-sigv4');

interface Context {
  credentials: { access_key_id: string; secret_access_key: string; token?: string };
  region: string;
  service: string;
  timestamp: string;
  sign_body?: boolean;
  omit_session_token?: boolean;
}

function parseRequest(text: string): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
} {
  const [head = '', body = ''] = text.split(/\n\n/, 2);
  const [requestLine = '', ...headerLines] = head.split('\n');
  const match = /^(\S+) (.+) HTTP\/1\.1$/.exec(requestLine);
  if (!match) throw new Error(`bad request line: ${requestLine}`);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    if (line === '') continue;
    const colon = line.indexOf(':');
    headers[line.slice(0, colon)] = line.slice(colon + 1);
  }
  return { method: match[1] ?? '', path: match[2] ?? '', headers, body };
}

const cases = readdirSync(DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('SigV4 signer against the AWS signing test suite', () => {
  it('has the vectors', () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
  });

  it.each(cases)('%s', (name) => {
    const read = (file: string) => readFileSync(join(DIR, name, file), 'utf8');
    const context = JSON.parse(read('context.json')) as Context;
    const request = parseRequest(read('request.txt'));
    const host = request.headers.Host ?? request.headers.host ?? '';
    const signed = signRequest({
      method: request.method,
      url: new URL(`https://${host}${request.path}`),
      headers: request.headers,
      body: request.body,
      region: context.region,
      service: context.service,
      credentials: {
        accessKeyId: context.credentials.access_key_id,
        secretAccessKey: context.credentials.secret_access_key,
        sessionToken: context.omit_session_token ? undefined : context.credentials.token,
      },
      now: new Date(context.timestamp),
      signBody: context.sign_body,
    });
    expect(signed.canonicalRequest).toBe(read('header-canonical-request.txt'));
    expect(signed.stringToSign).toBe(read('header-string-to-sign.txt'));
    expect(signed.signature).toBe(read('header-signature.txt').trim());
  });
});
