/**
 * The SMTP client against a real SMTP server on 127.0.0.1 (tests/helpers/fake-smtp-server.ts),
 * through the Node-backed `cloudflare:sockets` double, so the protocol, TLS upgrade and
 * certificate checks run over real sockets.
 */
import {
  buildSmtpMessage,
  createSmtpAgentEmailSender,
  sendSmtpMessage,
  type SmtpConfig,
  SmtpError,
} from '@simple-agent-manager/agent-email/definitions';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestTlsCertificates,
  type FakeSmtpOptions,
  type FakeSmtpServer,
  startFakeSmtpServer,
  type TestTlsCertificates,
} from '../../helpers/fake-smtp-server';
import { __setTestTlsCa } from '../../mocks/cloudflare-sockets';

const HOST_NAME = 'mail.example.com';
let certs: TestTlsCertificates;
let server: FakeSmtpServer | undefined;

beforeAll(() => {
  certs = createTestTlsCertificates([HOST_NAME, 'localhost']);
});

afterEach(async () => {
  __setTestTlsCa(undefined);
  await server?.close();
  server = undefined;
});

afterAll(() => __setTestTlsCa(undefined));

async function start(options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  server = await startFakeSmtpServer({ tls: certs, ...options });
  return server;
}

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: '127.0.0.1',
    port,
    tls: 'none',
    credentials: null,
    from: 'sign-in@example.com',
    ...overrides,
  };
}

function delivery(text = 'Your code is 123456') {
  return buildSmtpMessage(
    {
      from: { email: 'sign-in@example.com', name: 'SAM' },
      to: 'owner@example.com',
      subject: '123456 is your SAM sign-in code',
      text,
      headers: {},
    },
    { now: new Date('2026-11-11T00:00:00Z'), messageId: 'id@example.com' }
  );
}

const send = (smtp: SmtpConfig, timeoutMs = 5_000) =>
  sendSmtpMessage(smtp, delivery(), { timeoutMs, heloName: 'api.example.com' });

describe('sendSmtpMessage', () => {
  it('delivers over plaintext to a loopback collector and dot-unstuffs to the original body', async () => {
    const smtp = await start({ mode: 'plain' });
    const text = 'line one\n.starts with a dot\n..two dots\nend';
    await sendSmtpMessage(config(smtp.port), delivery(text), {
      timeoutMs: 5_000,
      heloName: 'api.example.com',
    });
    expect(smtp.messages).toHaveLength(1);
    const [message] = smtp.messages;
    expect(message?.from).toBe('sign-in@example.com');
    expect(message?.to).toEqual(['owner@example.com']);
    expect(message?.secure).toBe(false);
    expect(message?.data.split('\r\n\r\n')[1]).toBe(text.replace(/\n/g, '\r\n'));
    expect(smtp.commands[0]).toBe('EHLO api.example.com');
    expect(smtp.commands.at(-1)).toBe('QUIT');
  });

  it('upgrades with STARTTLS, verifies the certificate, then authenticates over TLS', async () => {
    __setTestTlsCa(certs.ca);
    const smtp = await start({
      mode: 'starttls',
      credentials: { username: 'relay-user', password: 'relay-pass' },
    });
    await send(
      config(smtp.port, {
        host: 'localhost',
        tls: 'starttls',
        credentials: { username: 'relay-user', password: 'relay-pass' },
      })
    );
    expect(smtp.messages).toEqual([
      expect.objectContaining({ secure: true, authenticatedAs: 'relay-user' }),
    ]);
    // AUTH happened only after the upgrade (the second EHLO).
    expect(smtp.commands.slice(0, 4)).toEqual([
      'EHLO api.example.com',
      'STARTTLS',
      'EHLO api.example.com',
      'AUTH PLAIN <redacted>',
    ]);
  });

  it('delivers over implicit TLS', async () => {
    __setTestTlsCa(certs.ca);
    const smtp = await start({ mode: 'implicit' });
    await send(config(smtp.port, { host: 'localhost', tls: 'tls' }));
    expect(smtp.messages).toEqual([expect.objectContaining({ secure: true })]);
  });

  it('refuses a server that does not offer STARTTLS and sends nothing in plaintext', async () => {
    const smtp = await start({ mode: 'starttls', offerStartTls: false });
    await expect(
      send(
        config(smtp.port, {
          host: 'localhost',
          tls: 'starttls',
          credentials: { username: 'u', password: 'p' },
        })
      )
    ).rejects.toThrow('does not offer STARTTLS');
    expect(smtp.commands).toEqual(['EHLO api.example.com']);
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses data the server sent ahead of the TLS handshake (STARTTLS injection)', async () => {
    __setTestTlsCa(certs.ca);
    const smtp = await start({ mode: 'starttls', injectAfterStartTls: '\r\n250 injected' });
    await expect(send(config(smtp.port, { host: 'localhost', tls: 'starttls' }))).rejects.toThrow(
      'sent data before TLS started'
    );
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses a certificate from an untrusted issuer', async () => {
    const smtp = await start({ mode: 'implicit' });
    await expect(send(config(smtp.port, { host: 'localhost', tls: 'tls' }))).rejects.toThrow(
      /self.signed|unable to verify|certificate/i
    );
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses a trusted certificate that does not name the configured host', async () => {
    // Names mail.example.com and 127.0.0.1, not localhost: the TLS handshake itself must fail.
    const other = createTestTlsCertificates(['mail.example.com']);
    __setTestTlsCa(other.ca);
    const smtp = await start({ mode: 'starttls', tls: other });
    await expect(send(config(smtp.port, { host: 'localhost', tls: 'starttls' }))).rejects.toThrow(
      /altnames|does not match|hostname/i
    );
    expect(smtp.commands).toEqual(['EHLO api.example.com', 'STARTTLS']);
    expect(smtp.messages).toHaveLength(0);
  });

  it('control: the same certificate is accepted for a name it does carry', async () => {
    const other = createTestTlsCertificates(['mail.example.com']);
    __setTestTlsCa(other.ca);
    const smtp = await start({ mode: 'starttls', tls: other });
    await send(config(smtp.port, { host: '127.0.0.1', tls: 'starttls' }));
    expect(smtp.messages).toEqual([expect.objectContaining({ secure: true })]);
  });

  it('refuses when the server answers STARTTLS with an error, and never continues in plaintext', async () => {
    const smtp = await start({ mode: 'starttls', startTlsCode: 454 });
    const failure = await send(config(smtp.port, { host: 'localhost', tls: 'starttls' })).catch(
      (error: unknown) => error
    );
    expect((failure as SmtpError).replyCode).toBe(454);
    expect(smtp.commands).toEqual(['EHLO api.example.com', 'STARTTLS']);
  });

  it('reports a wrong password by reply code without the password in the error', async () => {
    const smtp = await start({ mode: 'plain', credentials: { username: 'u', password: 'right' } });
    const failure = await send(
      config(smtp.port, { credentials: { username: 'u', password: 'wrong-secret' } })
    ).catch((error: unknown) => error);
    expect((failure as SmtpError).replyCode).toBe(535);
    expect((failure as SmtpError).message).not.toContain('wrong-secret');
    expect(smtp.commands.some((command) => command.startsWith('MAIL'))).toBe(false);
  });

  it('authenticates with a non-ASCII password (UTF-8)', async () => {
    const smtp = await start({
      mode: 'plain',
      credentials: { username: 'u', password: 'pässwörd€' },
    });
    await send(config(smtp.port, { credentials: { username: 'u', password: 'pässwörd€' } }));
    expect(smtp.messages[0]?.authenticatedAs).toBe('u');
  });

  it.each([
    ['MAIL FROM', { mailCode: 553 }, 553],
    ['message', { dataCode: 554 }, 554],
  ] as Array<[string, Partial<FakeSmtpOptions>, number]>)(
    'reports a refused %s as a failure',
    async (step, options, code) => {
      const smtp = await start({ mode: 'plain', ...options });
      const failure = await send(config(smtp.port)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SmtpError);
      expect((failure as SmtpError).message).toBe(`SMTP ${step} refused with ${code}`);
      expect(smtp.messages).toHaveLength(0);
    }
  );

  it('treats a dropped QUIT after an accepted message as delivered', async () => {
    const smtp = await start({ mode: 'plain', dropOnQuit: true });
    await send(config(smtp.port));
    expect(smtp.messages).toHaveLength(1);
  });

  it.each([
    ['a malformed reply', 'garbage\r\n', 'malformed SMTP reply'],
    [
      'inconsistent multi-line codes',
      '220-first\r\n221 second\r\n',
      'inconsistent SMTP reply codes',
    ],
    ['an endless reply line', 'x'.repeat(70 * 1024), 'SMTP reply too long'],
    ['too many reply lines', '220-x\r\n'.repeat(150), 'SMTP reply too long'],
  ])('refuses %s', async (_, rawGreeting, message) => {
    const smtp = await start({ mode: 'plain', rawGreeting });
    await expect(send(config(smtp.port))).rejects.toThrow(message);
  });

  it('cannot be made to inject SMTP commands through the body (smuggling)', async () => {
    const smtp = await start({ mode: 'plain' });
    for (const text of [
      'x\n.\nMAIL FROM:<a@b.example>\nRCPT TO:<c@d.example>',
      'x\r.\rMAIL FROM:<a@b.example>',
      'x\r\n.\r\nRCPT TO:<c@d.example>',
    ]) {
      await sendSmtpMessage(config(smtp.port), delivery(text), {
        timeoutMs: 5_000,
        heloName: 'api.example.com',
      });
    }
    expect(smtp.messages).toHaveLength(3);
    expect(smtp.commands.filter((command) => command.startsWith('MAIL'))).toHaveLength(3);
    expect(smtp.commands.filter((command) => command.startsWith('RCPT'))).toHaveLength(3);
  });

  it('gives up at the deadline during a stalled TLS handshake', async () => {
    // A plaintext listener that never answers a TLS ClientHello.
    const smtp = await start({ mode: 'plain', silent: true });
    await expect(send(config(smtp.port, { host: 'localhost', tls: 'tls' }), 300)).rejects.toThrow(
      'timed out after 300 ms'
    );
  });

  it('reports a refused recipient by reply code without echoing the server text', async () => {
    const smtp = await start({ mode: 'plain', rcptCode: 550 });
    const failure = await send(config(smtp.port)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SmtpError);
    expect((failure as SmtpError).replyCode).toBe(550);
    expect((failure as SmtpError).message).toBe('SMTP RCPT TO refused with 550');
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses when credentials are configured but the server offers no AUTH PLAIN', async () => {
    const smtp = await start({ mode: 'plain' });
    await expect(
      send(config(smtp.port, { credentials: { username: 'u', password: 'p' } }))
    ).rejects.toThrow('does not offer AUTH PLAIN');
    expect(smtp.commands.some((command) => command.startsWith('MAIL'))).toBe(false);
  });

  it('gives up at the deadline when the server never answers', async () => {
    const smtp = await start({ mode: 'plain', silent: true });
    const started = Date.now();
    await expect(send(config(smtp.port), 200)).rejects.toThrow('timed out after 200 ms');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('fails cleanly when nothing listens on the port', async () => {
    const smtp = await start({ mode: 'plain' });
    const port = smtp.port;
    await smtp.close();
    server = undefined;
    await expect(send(config(port))).rejects.toThrow(SmtpError);
  });
});

describe('createSmtpAgentEmailSender', () => {
  it('sends through the AgentEmailSender interface and returns the Message-ID it used', async () => {
    const smtp = await start({ mode: 'plain' });
    const sender = createSmtpAgentEmailSender(config(smtp.port), {
      timeoutMs: 5_000,
      heloName: 'api.example.com',
    });
    const { providerMessageId } = await sender.send({
      from: { email: 'sign-in@example.com', name: 'SAM' },
      to: 'owner@example.com',
      subject: 'hello',
      text: 'body',
      headers: {},
    });
    expect(providerMessageId).toMatch(/^[0-9a-f]{32}@example\.com$/);
    expect(smtp.messages[0]?.data).toContain(`Message-ID: <${providerMessageId}>`);
  });
});
