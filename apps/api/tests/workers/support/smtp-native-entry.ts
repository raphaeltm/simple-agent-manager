/**
 * Test-only Worker for `tests/workers/smtp-client-workerd.test.ts`: runs the production SMTP
 * client inside real workerd, so its `cloudflare:sockets` calls (connect, startTls, the
 * reader/writer locks, certificate verification) meet the real runtime instead of the Node
 * double the unit tests use. POST a JSON body `{ op, config, envelope? }`.
 */
import {
  buildSmtpMessage,
  probeSmtpRelay,
  sendSmtpMessage,
  type SmtpConfig,
  SmtpError,
} from '@simple-agent-manager/agent-email/definitions';

interface Body {
  op: 'send' | 'probe';
  config: SmtpConfig;
  timeoutMs?: number;
}

const ENVELOPE = { envelopeFrom: 'sign-in@example.com', envelopeTo: 'owner@example.com' };

export default {
  async fetch(request: Request): Promise<Response> {
    const body = (await request.json()) as Body;
    const options = { timeoutMs: body.timeoutMs ?? 5_000, heloName: 'api.example.com' };
    try {
      if (body.op === 'probe') {
        await probeSmtpRelay(body.config, ENVELOPE, options);
      } else {
        const message = buildSmtpMessage(
          {
            from: { email: ENVELOPE.envelopeFrom, name: 'SAM' },
            to: ENVELOPE.envelopeTo,
            subject: '123456 is your SAM sign-in code',
            text: 'Your code is 123456\n.a line starting with a dot',
            headers: {},
          },
          { now: new Date('2026-11-18T00:00:00Z'), messageId: 'id@example.com' }
        );
        await sendSmtpMessage(body.config, message, options);
      }
      return Response.json({ ok: true });
    } catch (error) {
      return Response.json({
        ok: false,
        smtpError: error instanceof SmtpError,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },
};
