import { describe, expect, it } from 'vitest';

import type { OutboundAgentEmail } from '../../../src/services/agent-email/provider';
import {
  buildSmtpMessage,
  dotStuff,
  SmtpMessageError,
} from '../../../src/services/agent-email/smtp-message';

const base: OutboundAgentEmail = {
  from: { email: 'sign-in@example.com', name: 'SAM' },
  to: 'owner@example.com',
  subject: '123456 is your SAM sign-in code',
  text: 'Your code is\n\n    123456\n',
  headers: {},
};

const options = { now: new Date('2026-11-11T08:30:00Z'), messageId: 'abc@example.com' };

function headers(data: string): string[] {
  return data.split('\r\n\r\n')[0]?.split('\r\n') ?? [];
}

describe('buildSmtpMessage', () => {
  it('builds a 7-bit message with CRLF line endings and the envelope addresses', () => {
    const built = buildSmtpMessage(base, options);
    expect(built.envelopeFrom).toBe('sign-in@example.com');
    expect(built.envelopeTo).toBe('owner@example.com');
    expect(headers(built.data)).toEqual([
      'From: "SAM" <sign-in@example.com>',
      'To: owner@example.com',
      'Subject: 123456 is your SAM sign-in code',
      'Date: Wed, 11 Nov 2026 08:30:00 +0000',
      'Message-ID: <abc@example.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
    ]);
    expect(built.data.split('\r\n\r\n').slice(1).join('\r\n\r\n')).toBe(
      'Your code is\r\n\r\n    123456\r\n'
    );
  });

  it('encodes a non-ASCII subject, name and body instead of sending 8-bit data', () => {
    const built = buildSmtpMessage(
      {
        ...base,
        subject: 'Code für Anmeldung',
        from: { email: base.from.email, name: 'Équipe' },
        text: 'Grüße',
      },
      options
    );
    const head = headers(built.data);
    expect(head).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Code für Anmeldung').toString('base64')}?=`
    );
    expect(head).toContain(
      `From: =?UTF-8?B?${Buffer.from('Équipe').toString('base64')}?= <sign-in@example.com>`
    );
    expect(head).toContain('Content-Transfer-Encoding: base64');
    const body = built.data.split('\r\n\r\n')[1] ?? '';
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Grüße');
    // eslint-disable-next-line no-control-regex -- asserting the wire is 7-bit
    expect(built.data).toMatch(/^[\x00-\x7f]*$/);
  });

  it('quotes a display name that contains quotes or backslashes', () => {
    const built = buildSmtpMessage(
      { ...base, from: { email: base.from.email, name: 'S"A\\M' } },
      options
    );
    expect(headers(built.data)[0]).toBe('From: "S\\"A\\\\M" <sign-in@example.com>');
  });

  it.each([
    ['subject', { subject: 'hi\r\nBcc: victim@example.com' }],
    ['from name', { from: { email: 'sign-in@example.com', name: 'SAM\r\nBcc: x@example.com' } }],
    ['recipient', { to: 'owner@example.com>\r\nRCPT TO:<victim@example.com' }],
    ['sender address', { from: { email: 'a@b.example\r\n', name: 'SAM' } }],
    ['extra header value', { headers: { 'X-Thing': 'ok\r\nBcc: victim@example.com' } }],
    ['extra header name', { headers: { 'X-Bad Name': 'x' } }],
    ['reserved header', { headers: { Bcc: 'victim@example.com' } }],
    ['reserved header (case)', { headers: { 'reply-to': 'victim@example.com' } }],
  ] as Array<[string, Partial<OutboundAgentEmail>]>)(
    'refuses header injection through the %s',
    (_, override) => {
      expect(() => buildSmtpMessage({ ...base, ...override }, options)).toThrow(SmtpMessageError);
    }
  );

  it('allows a well-formed extra header', () => {
    const built = buildSmtpMessage(
      { ...base, headers: { 'In-Reply-To': '<x@example.com>' } },
      options
    );
    expect(headers(built.data)).toContain('In-Reply-To: <x@example.com>');
  });

  it('base64-encodes a body with a line over the RFC 5322 limit', () => {
    const built = buildSmtpMessage({ ...base, text: 'a'.repeat(1_200) }, options);
    expect(headers(built.data)).toContain('Content-Transfer-Encoding: base64');
    for (const line of built.data.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
  });
});

describe('dotStuff', () => {
  it('doubles a leading dot on every line and appends the terminator', () => {
    expect(dotStuff('.first\r\nmiddle\r\n.\r\n..x')).toBe(
      '..first\r\nmiddle\r\n..\r\n...x\r\n.\r\n'
    );
  });

  it('leaves dots elsewhere in a line alone', () => {
    expect(dotStuff('a.b\r\nc .d')).toBe('a.b\r\nc .d\r\n.\r\n');
  });
});
