import { describe, expect, it } from 'vitest';

import {
  agentEmailAddress,
  generateAddressKey,
  normalizeMailbox,
  parseAgentEmailRecipient,
} from '../../../src/services/agent-email/address';
import {
  MAX_HEADER_VALUE_BYTES,
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
    expect(parseAgentEmailRecipient('Agent+K3J2H7M9Q2XW4N8P@AGENTS.fixture.example', BASE)).toEqual(
      {
        kind: 'trigger',
        key: SAMPLE_ID,
      }
    );
    expect(parseAgentEmailRecipient('agent+loopback@agents.fixture.example', BASE)).toEqual({
      kind: 'loopback',
    });
    for (const rejected of [
      'agent@agents.fixture.example', // base address, no key
      'agent+short@agents.fixture.example',
      'agent+k3j2h7m9q2xw4n8u@agents.fixture.example', // 'u' is not in the alphabet
      'other+k3j2h7m9q2xw4n8p@agents.fixture.example',
      'agent+k3j2h7m9q2xw4n8p@fixture.example', // apex, not mail.
      'agent+k3j2h7m9q2xw4n8p@agents.fixture.example.evil.test',
      'agent+k3j2h7m9q2xw4n8p@agents.fixture.example@x',
      '',
    ]) {
      expect(parseAgentEmailRecipient(rejected, BASE)).toBeNull();
    }
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

  it('keeps the reference chain within the header size limit, dropping the oldest first', () => {
    // The longest ids parseMessageIdList accepts: 200 characters on each side of the @.
    const longId = (index: number) => `<${String(index).padStart(200, 'r')}@${'d'.repeat(200)}>`;
    const many = Array.from({ length: 20 }, (_, index) => longId(index));
    const current = longId(99);

    const chain = replyReferences(many, current);

    expect(new TextEncoder().encode(chain.join(' ')).byteLength).toBeLessThanOrEqual(
      MAX_HEADER_VALUE_BYTES
    );
    expect(chain.at(-1)).toBe(current);
    expect(chain.slice(0, -1)).toEqual(many.slice(-(chain.length - 1)));

    // Multi-byte ids are measured in bytes, not characters.
    const wide = Array.from({ length: 20 }, (_, index) => `<${'é'.repeat(150)}${index}@x>`);
    const wideChain = replyReferences(wide, '<m@example.com>');
    expect(new TextEncoder().encode(wideChain.join(' ')).byteLength).toBeLessThanOrEqual(
      MAX_HEADER_VALUE_BYTES
    );
    expect(wideChain.at(-1)).toBe('<m@example.com>');
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
  const envelope = { from: 'Alice@Example.com', to: 'agent+k@agents.fixture.example' };

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

  function htmlMail(html: string[]): string {
    return mime([
      'From: bob@example.org',
      'Subject: HTML',
      'Message-ID: <m4@example.org>',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      ...html,
    ]);
  }

  it('keeps the text of HTML mail whose head is far longer than the body limit', async () => {
    const styles = Array.from({ length: 2000 }, (_, index) => `.c${index}{color:red}`);
    const raw = htmlMail([
      '<html><head><style>',
      ...styles,
      '</style></head>',
      '<body><p>Deploy the fix</p></body></html>',
    ]);

    const email = await parseInboundEmail(raw, envelope, 100);

    expect(email).toMatchObject({ text: 'Deploy the fix', textTruncated: false });
  });

  it('decodes entities, drops comments, scripts and markup, and keeps Unicode intact', async () => {
    const raw = htmlMail([
      '<p>İstanbul &amp; caf&#233; &#x2014; it&#8217;s <!-- a > hidden note --><B>done</B></p>',
      '<SCRIPT type="text/javascript">document.write("</p>visible?")</SCRIPT>',
      '<p>&bogus; &#xFFFFFF; &lt;b&gt;</p>',
    ]);

    const email = await parseInboundEmail(raw, envelope, 1000);

    expect(email.text).toBe('İstanbul & café — it’s done\n\n&bogus; &#xFFFFFF; <b>');
  });

  // Measured 2026-10-22: the linear converter takes 1-4 ms on each input; the regex converter it
  // replaced took 6.8-9.4 s. The 2 s bound sits far from both, so it is neither flaky nor blind.
  it.each([
    ['unclosed tags', '<'.repeat(100_000)],
    ['unclosed skipped elements', '<style>'.repeat(60_000)],
    ['a long run of spaces inside a line', `start${' '.repeat(100_000)}end`],
  ])('converts hostile HTML (%s) in linear time', async (_case, hostile) => {
    const started = performance.now();

    await parseInboundEmail(htmlMail(['<p>Hello</p>', hostile]), envelope, 1000);

    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reports a missing or malformed From as null rather than guessing', async () => {
    const raw = mime(['Subject: No sender', 'Message-ID: <m3@example.org>', '', 'body']);
    expect((await parseInboundEmail(raw, envelope, 100)).from).toBeNull();
  });
});
