import { afterEach, describe, expect, it, vi } from 'vitest';

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
    ORIGIN_CA_RETRY_BASE_DELAY_MS: '1',
    ORIGIN_CA_RETRY_MAX_DELAY_MS: '2',
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

  it('surfaces a clear error for a non-JSON Cloudflare response body', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response('<html>upstream error</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).rejects.toThrow(
      'Cloudflare Origin CA returned non-JSON response (502)'
    );
  });

  it('surfaces a clear error instead of crashing on a literal JSON null response', async () => {
    // Regression: the previous blind cast (`as CloudflareOriginCaResponse`)
    // let `payload` be `null`. `payload.result?.certificate` then threw an
    // uncaught TypeError ("Cannot read properties of null") instead of the
    // domain-specific "non-JSON response" error every other malformed-body
    // path already produces.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

    await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).rejects.toThrow(
      'Cloudflare Origin CA returned non-JSON response (200)'
    );
  });

  it('gracefully degrades a JSON array response to the issuance-failed error (does not crash)', async () => {
    // Arrays are typeof 'object' in JS, so the old blind cast tolerated them
    // too (property access just returned undefined). The schema-validated
    // path preserves that tolerance rather than rejecting it as non-JSON.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

    await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).rejects.toThrow(
      'Cloudflare Origin CA certificate issuance failed (200)'
    );
  });
});

describe('bounded Origin CA recovery', () => {
  afterEach(() => vi.useRealTimers());
  it.each([429, 500, 502, 503])(
    'retries HTTP %s then succeeds with the same CSR',
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('upstream failure', { status }))
        .mockResolvedValueOnce(Response.json({ success: true, result: { certificate: 'signed' } }));
      await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).resolves.toMatchObject({
        certificate: 'signed\n',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    }
  );
  it.each([400, 401, 403])('never retries permanent HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockImplementation(() => new Response('denied', { status }));
    await expect(issueNodeOriginCertificate(env(), CSR, fetchMock)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('caps exponential backoff and attempts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.reject(new Error('network failure')));
    const outcome = issueNodeOriginCertificate(
      env({
        ORIGIN_CA_RETRY_MAX_ATTEMPTS: '4',
        ORIGIN_CA_RETRY_BASE_DELAY_MS: '100',
        ORIGIN_CA_RETRY_MAX_DELAY_MS: '150',
      }),
      CSR,
      fetchMock
    ).catch((e) => e);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(150);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(await outcome).toBeInstanceOf(Error);
  });
  it('aborts hung requests and exhausts its configured budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('request aborted')));
        })
    );
    const outcome = issueNodeOriginCertificate(
      env({ ORIGIN_CA_REQUEST_TIMEOUT_MS: '100', ORIGIN_CA_RETRY_MAX_ATTEMPTS: '2' }),
      CSR,
      fetchMock
    ).catch((e) => e);
    await vi.runAllTimersAsync();
    expect(await outcome).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal.aborted)).toBe(true);
  });
});
