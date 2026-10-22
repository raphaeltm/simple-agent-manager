import { describe, expect, it } from 'vitest';

import {
  agentEmailAddress,
  agentEmailConfig,
  generateAddressKey,
  normalizeMailbox,
  parseAgentEmailRecipient,
} from '../../../src/services/agent-email/address';
import {
  MAX_REFERENCES,
  parseMessageIdList,
  parseSingleMessageId,
  replyReferences,
  replySubject,
  sanitizeDisplayName,
} from '../../../src/services/agent-email/headers';
import { parseInboundEmail } from '../../../src/services/agent-email/inbound-message';

const BASE = 'Fixture.Example';
const SAMPLE_ID = 'k3j2h7m9q2xw4n8p';

describe('agent email addresses', () => {
  it('generates 16-character Crockford base32 keys that round-trip through the parser', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateAddressKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
      expect(parseAgentEmailRecipient(agentEmailAddress(BASE, key), BASE)).toEqual({
        kind: 'trigger',
        key,
      });
    }
  });

  it('accepts the routed address case-insensitively and nothing else', () => {
    expect(parseAgentEmailRecipient('Agent+K3J2H7M9Q2XW4N8P@MAIL.fixture.example', BASE)).toEqual({
      kind: 'trigger',
      key: SAMPLE_ID,
    });
    expect(parseAgentEmailRecipient('agent+loopback@mail.fixture.example', BASE)).toEqual({
      kind: 'loopback',
    });
    for (const rejected of [
      'agent@mail.fixture.example', // base address, no key
      'agent+short@mail.fixture.example',
      'agent+k3j2h7m9q2xw4n8u@mail.fixture.example', // 'u' is not in the alphabet
      'other+k3j2h7m9q2xw4n8p@mail.fixture.example',
      'agent+k3j2h7m9q2xw4n8p@fixture.example', // apex, not mail.
      'agent+k3j2h7m9q2xw4n8p@mail.fixture.example.evil.test',
      'agent+k3j2h7m9q2xw4n8p@mail.fixture.example@x',
      '',
    ]) {
      expect(parseAgentEmailRecipient(rejected, BASE)).toBeNull();
    }
  });

  it('reports availability from the binding, not from configuration alone', () => {
    expect(agentEmailConfig({ BASE_DOMAIN: 'fixture.example' })).toEqual({
      enabled: false,
      domain: null,
    });
    expect(
      agentEmailConfig({ BASE_DOMAIN: 'fixture.example', AGENT_EMAIL: {} as SendEmail })
    ).toEqual({ enabled: true, domain: 'mail.fixture.example' });
  });

  it('normalizes mailboxes and refuses anything that is not one', () => {
    expect(normalizeMailbox('  Alice@Example.COM ')).toBe('alice@example.com');
    for (const bad of ['alice', 'a@', '@b', 'a b@c.d', 'a@b@c', '<a@b.c>', null, undefined]) {
      expect(normalizeMailbox(bad)).toBeNull();
    }
  });
});

describe('agent email header handling', () => {
  it('keeps only well-formed message ids, in order and without duplicates', () => {
    expect(parseMessageIdList('<a@x> junk <b@y> <a@x> <no-at> <c@z>')).toEqual([
      '<a@x>',
      '<b@y>',
      '<c@z>',
    ]);
    expect(parseSingleMessageId(' <m1@example.com> ')).toBe('<m1@example.com>');
    expect(parseSingleMessageId('<m1@example.com> <m2@example.com>')).toBeNull();
    expect(parseSingleMessageId('m1@example.com')).toBeNull();
  });

  it('chains references newest-last and caps the chain', () => {
    const many = Array.from({ length: 40 }, (_, index) => `<r${index}@example.com>`);
    const chain = replyReferences(many, '<m@example.com>');
    expect(chain).toHaveLength(MAX_REFERENCES);
    expect(chain.at(-1)).toBe('<m@example.com>');
    expect(replyReferences(['<m@example.com>'], '<m@example.com>')).toEqual(['<m@example.com>']);
  });

  it('builds a single-line reply subject', () => {
    expect(replySubject('Login bug')).toBe('Re: Login bug');
    expect(replySubject('RE: Login bug')).toBe('RE: Login bug');
    expect(replySubject('')).toBe('Re: (no subject)');
    expect(replySubject('Hi\r\nBcc: evil@example.net')).toBe('Re: Hi Bcc: evil@example.net');
    expect(replySubject('x'.repeat(1000)).length).toBeLessThanOrEqual(300);
    expect(sanitizeDisplayName('"Mallory" <m@x>\r\n')).toBe('Mallory m@x');
  });
});

function mime(lines: string[]): string {
  return lines.join('\r\n');
}

describe('inbound email parsing', () => {
  const envelope = { from: 'Alice@Example.com', to: 'agent+k@mail.fixture.example' };

  it('prefers the plain-text part of a multipart message and summarizes attachments', async () => {
    const raw = mime([
      'From: "Alice Example" <Alice@Example.com>',
      'Subject: Report attached',
      'Message-ID: <m1@example.com>',
      'References: <r0@example.com> bogus <r1@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain body wins.',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML body</p>',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
      '--outer--',
    ]);

    const email = await parseInboundEmail(raw, envelope, 1000);

    expect(email).toMatchObject({
      envelopeFrom: 'alice@example.com',
      from: 'alice@example.com',
      fromName: 'Alice Example',
      subject: 'Report attached',
      messageId: '<m1@example.com>',
      references: ['<r0@example.com>', '<r1@example.com>'],
      text: 'Plain body wins.',
      textTruncated: false,
      autoSubmitted: null,
      hasListId: false,
    });
    expect(email.attachments).toEqual([
      { filename: 'report.pdf', mimeType: 'application/pdf', size: 13 },
    ]);
  });

  it('falls back to readable text for HTML-only mail and truncates long bodies', async () => {
    const raw = mime([
      'From: bob@example.org',
      'Subject: HTML only',
      'Message-ID: <m2@example.org>',
      'Auto-Submitted: Auto-Replied',
      'Precedence: Bulk',
      'List-Id: <team.lists.example.org>',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<html><head><style>p{color:red}</style></head><body><p>Hello <b>agent</b>,</p><p>Fix &amp; ship.</p></body></html>',
    ]);

    const full = await parseInboundEmail(raw, envelope, 1000);
    expect(full.text).toBe('Hello agent,\nFix & ship.');
    expect(full).toMatchObject({
      autoSubmitted: 'auto-replied',
      precedence: 'bulk',
      hasListId: true,
    });

    const cut = await parseInboundEmail(raw, envelope, 5);
    expect(cut).toMatchObject({ text: 'Hello', textTruncated: true });
  });

  it('reports a missing or malformed From as null rather than guessing', async () => {
    const raw = mime(['Subject: No sender', 'Message-ID: <m3@example.org>', '', 'body']);
    expect((await parseInboundEmail(raw, envelope, 100)).from).toBeNull();
  });
});
