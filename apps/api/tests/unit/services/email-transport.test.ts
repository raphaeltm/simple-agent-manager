/**
 * `emailTransportKind`: the one decision about how SAM sends its own email. Each case loads the
 * module fresh, because invalid SMTP settings are reported once per isolate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailTransportEnv } from '../../../src/services/agent-email/provider';

const binding = { send: vi.fn() } as unknown as SendEmail;
const invalidSmtp = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_TLS: 'none',
  SMTP_PORT: '25',
  SMTP_USERNAME: 'relay-user',
  SMTP_PASSWORD: 'super-secret-password',
  SMTP_FROM: 'sign-in@example.com',
};

async function load() {
  vi.resetModules();
  return import('../../../src/services/agent-email/provider');
}

describe('emailTransportKind', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it('reports invalid SMTP settings once per isolate, without the password', async () => {
    const { emailTransportKind } = await load();
    const env: EmailTransportEnv = { BASE_DOMAIN: 'example.com', ...invalidSmtp };
    for (let i = 0; i < 3; i += 1) expect(emailTransportKind(env)).toBeNull();
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes('email_transport.smtp_settings_invalid'))).toEqual([
      expect.stringContaining('SMTP_TLS=none is allowed only for a loopback SMTP_HOST'),
    ]);
    expect(lines.join('\n')).not.toContain('super-secret-password');
  });

  it('uses the Cloudflare binding and ignores SMTP settings, even invalid ones', async () => {
    const { emailTransportKind } = await load();
    expect(
      emailTransportKind({ BASE_DOMAIN: 'example.com', AGENT_EMAIL: binding, ...invalidSmtp })
    ).toBe('cloudflare');
    expect(errors).not.toHaveBeenCalled();
  });

  it('sends nothing without a base domain', async () => {
    const { emailTransportKind } = await load();
    expect(emailTransportKind({ BASE_DOMAIN: '', AGENT_EMAIL: binding })).toBeNull();
    expect(
      emailTransportKind({
        BASE_DOMAIN: ' ',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1025',
        SMTP_TLS: 'none',
        SMTP_FROM: 'a@example.com',
      })
    ).toBeNull();
  });

  it('control: valid SMTP settings without the binding select SMTP', async () => {
    const { emailTransportKind } = await load();
    expect(
      emailTransportKind({
        BASE_DOMAIN: 'example.com',
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1025',
        SMTP_TLS: 'none',
        SMTP_FROM: 'a@example.com',
      })
    ).toBe('smtp');
  });
});
