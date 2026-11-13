import { describe, expect, it } from 'vitest';

import {
  isLoopbackHost,
  resolveSmtpConfig,
  type SmtpEnv,
} from '../../src/smtp-config';

const relay: SmtpEnv = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_USERNAME: 'relay-user',
  SMTP_PASSWORD: 'relay-pass',
  SMTP_FROM: 'sign-in@sam.example.com',
};

function problem(env: SmtpEnv): string {
  const result = resolveSmtpConfig(env);
  if (result.status !== 'invalid') throw new Error(`expected invalid, got ${result.status}`);
  return result.problem;
}

describe('resolveSmtpConfig', () => {
  it('is absent without SMTP_HOST, whatever else is set', () => {
    expect(resolveSmtpConfig({})).toEqual({ status: 'absent' });
    expect(resolveSmtpConfig({ ...relay, SMTP_HOST: '  ' })).toEqual({ status: 'absent' });
  });

  it('defaults to STARTTLS on the submission port', () => {
    expect(resolveSmtpConfig(relay)).toEqual({
      status: 'ok',
      config: {
        host: 'smtp.example.com',
        port: 587,
        tls: 'starttls',
        credentials: { username: 'relay-user', password: 'relay-pass' },
        from: 'sign-in@sam.example.com',
      },
    });
  });

  it('defaults implicit TLS to port 465 and honours an explicit port', () => {
    const tls = resolveSmtpConfig({ ...relay, SMTP_TLS: 'TLS' });
    expect(tls.status === 'ok' && tls.config.port).toBe(465);
    const custom = resolveSmtpConfig({ ...relay, SMTP_PORT: '2525' });
    expect(custom.status === 'ok' && custom.config.port).toBe(2525);
  });

  it('accepts plaintext only to a loopback host, and then requires a port', () => {
    const collector = resolveSmtpConfig({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_TLS: 'none',
      SMTP_FROM: 'sign-in@sam.example.com',
    });
    expect(collector).toMatchObject({ status: 'ok', config: { tls: 'none', credentials: null } });
    expect(problem({ ...relay, SMTP_TLS: 'none', SMTP_PORT: '25' })).toBe(
      'SMTP_TLS=none is allowed only for a loopback SMTP_HOST'
    );
    expect(problem({ SMTP_HOST: '127.0.0.1', SMTP_TLS: 'none', SMTP_FROM: 'a@b.example' })).toBe(
      'SMTP_PORT is required when SMTP_TLS is none'
    );
  });

  it.each([
    [{ SMTP_TLS: 'ssl' }, 'SMTP_TLS must be starttls, tls or none'],
    [{ SMTP_PORT: '0' }, 'SMTP_PORT must be an integer between 1 and 65535'],
    [{ SMTP_PORT: '587abc' }, 'SMTP_PORT must be an integer between 1 and 65535'],
    [{ SMTP_HOST: 'smtp.example.com\r\nRCPT' }, 'SMTP_HOST must be a hostname or an IP address'],
    [{ SMTP_PASSWORD: '' }, 'SMTP_USERNAME and SMTP_PASSWORD must be set together'],
    [{ SMTP_USERNAME: '' }, 'SMTP_USERNAME and SMTP_PASSWORD must be set together'],
    [
      { SMTP_PASSWORD: 'pa\r\nss' },
      'SMTP_USERNAME and SMTP_PASSWORD must not contain line breaks or NUL',
    ],
    [{ SMTP_FROM: '' }, 'SMTP_FROM must be a plain ASCII email address'],
    [{ SMTP_FROM: 'SAM <sign-in@example.com>' }, 'SMTP_FROM must be a plain ASCII email address'],
    [
      { SMTP_FROM: 'sign-in@example.com>\r\nRCPT TO:<x@y.z' },
      'SMTP_FROM must be a plain ASCII email address',
    ],
  ] as Array<[SmtpEnv, string]>)('refuses %o', (override, expected) => {
    expect(problem({ ...relay, ...override })).toBe(expected);
  });

  it('refuses plaintext to a name, even localhost: only loopback IP literals', () => {
    expect(
      problem({
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_TLS: 'none',
        SMTP_FROM: 'a@b.example',
      })
    ).toBe('SMTP_TLS=none is allowed only for a loopback SMTP_HOST');
  });

  it.each([
    'sign-in%relay@example.com',
    'a!b@example.com',
    'a|b@example.com',
    "o'brien@example.com",
  ])('refuses routing or command characters in SMTP_FROM: %s', (from) => {
    expect(problem({ ...relay, SMTP_FROM: from })).toBe(
      'SMTP_FROM must be a plain ASCII email address'
    );
  });

  it('refuses a username with a line break, an over-long host and an over-long address', () => {
    expect(problem({ ...relay, SMTP_USERNAME: 'a\nb' })).toBe(
      'SMTP_USERNAME and SMTP_PASSWORD must not contain line breaks or NUL'
    );
    expect(problem({ ...relay, SMTP_HOST: `${'a'.repeat(60)}.`.repeat(5) + 'com' })).toBe(
      'SMTP_HOST must be a hostname or an IP address'
    );
    expect(problem({ ...relay, SMTP_FROM: `${'a'.repeat(250)}@example.com` })).toBe(
      'SMTP_FROM must be a plain ASCII email address'
    );
  });

  it('lower-cases SMTP_FROM', () => {
    const result = resolveSmtpConfig({ ...relay, SMTP_FROM: 'Sign-In@SAM.Example.com' });
    expect(result.status === 'ok' && result.config.from).toBe('sign-in@sam.example.com');
  });

  it('keeps a password exactly as given, surrounding spaces included', () => {
    const result = resolveSmtpConfig({ ...relay, SMTP_PASSWORD: ' secret ' });
    expect(result.status === 'ok' && result.config.credentials?.password).toBe(' secret ');
  });

  it('strips brackets from an IPv6 literal', () => {
    const result = resolveSmtpConfig({
      SMTP_HOST: '[::1]',
      SMTP_PORT: '1025',
      SMTP_TLS: 'none',
      SMTP_FROM: 'a@b.example',
    });
    expect(result.status === 'ok' && result.config.host).toBe('::1');
  });
});

describe('isLoopbackHost', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.10.0.3', true],
    ['localhost', false],
    ['LOCALHOST', false],
    ['127.999.0.1', false],
    ['127.0.0.256', false],
    ['[::1]', true],
    ['10.0.0.1', false],
    ['127.0.0.1.example.com', false],
    ['localhost.example.com', false],
  ])('%s -> %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});
