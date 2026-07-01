import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildOriginCaHostnames,
  issueNodeOriginCertificate,
  resolveOriginCaValidityDays,
} from '../../../src/services/origin-ca-certificates';

const CSR = [
  '-----BEGIN CERTIFICATE REQUEST-----',
  'MIIBUzCB/QIBADAWMRQwEgYDVQQDEwtub2RlLXRlc3QwXDANBgkqhkiG9w0BAQEF',
  'AANLADBIAkEA0HP1uR9jfnFvD6h9P5gQ2fVw0tZNNqYiT7WL4S2c5tqR0CkW3Jj3',
  'o9C5zU3n+J8z9kA2q7dLa8YyMPpH6wIDAQABoAAwDQYJKoZIhvcNAQELBQADQQAF',
  'y8QvVrrqzXK6yH9E8pFzj0yJrUiXjZk5GmQxG1c5M4n0Qv7YqgC6h8jYwKpR2sU',
  '-----END CERTIFICATE REQUEST-----',
].join('\n');

function env(overrides?: Partial<Env>): Env {
  return {
    BASE_DOMAIN: 'Example.COM',
    CF_API_TOKEN: 'cf-token-secret',
    ...overrides,
  } as Env;
}

describe('origin CA certificate issuance', () => {
  it('builds wildcard hostnames from BASE_DOMAIN', () => {
    expect(buildOriginCaHostnames('Example.COM')).toEqual([
      '*.example.com',
      '*.vm.example.com',
      'example.com',
    ]);
  });

  it('uses 7-day validity by default and accepts Cloudflare-supported overrides', () => {
    expect(resolveOriginCaValidityDays(undefined)).toBe(7);
    expect(resolveOriginCaValidityDays('30')).toBe(30);
    expect(() => resolveOriginCaValidityDays('14')).toThrow('ORIGIN_CA_CERT_VALIDITY_DAYS');
  });

  it('posts the node CSR to Cloudflare Origin CA and returns the signed certificate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          result: {
            certificate: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----',
            id: 'cert-123',
            expires_on: '2026-07-02T00:00:00Z',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await issueNodeOriginCertificate(
      env({ ORIGIN_CA_CERT_VALIDITY_DAYS: '30' }),
      `${CSR}\n`,
      fetchMock
    );

    expect(result).toEqual({
      certificate: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n',
      certificateId: 'cert-123',
      expiresOn: '2026-07-02T00:00:00Z',
      hostnames: ['*.example.com', '*.vm.example.com', 'example.com'],
      requestedValidity: 30,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/certificates');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer cf-token-secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      csr: CSR,
      hostnames: ['*.example.com', '*.vm.example.com', 'example.com'],
      request_type: 'origin-rsa',
      requested_validity: 30,
    });
  });

  it('rejects malformed CSR input before calling Cloudflare', async () => {
    const fetchMock = vi.fn();

    await expect(issueNodeOriginCertificate(env(), 'not a csr', fetchMock)).rejects.toThrow(
      'Invalid Origin CA CSR PEM'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces Cloudflare Origin CA failures without returning a certificate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ message: 'hostnames are invalid' }],
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).rejects.toThrow(
      'hostnames are invalid'
    );
  });
});
