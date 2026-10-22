/**
 * Agent email loopback self-test (superadmin diagnostic). Sends one fixed message from the
 * routed address `agent+loopback@mail.<BASE_DOMAIN>` to an existing email trigger. When the
 * trigger's agent replies, the reply is routed back to this Worker and recorded here, which
 * proves outbound delivery and inbound routing end to end without a personal mailbox.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { loopbackAddress } from './address';
import type { AgentEmailSender } from './provider';

const LAST_SENT_KEY = 'agent-email:loopback:last-sent';
const LAST_RECEIVED_KEY = 'agent-email:loopback:last-received';
/** Loopback status is a short-lived diagnostic; it expires after a week. */
const LOOPBACK_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60;

export const LOOPBACK_SUBJECT = 'SAM agent email loopback test';
export const LOOPBACK_BODY = [
  'This is an automatic SAM agent email loopback test.',
  'Please reply to this email with the single word PONG using your reply_to_email tool.',
].join('\n');

export interface LoopbackSent {
  to: string;
  sentAt: string;
  providerMessageId: string;
}

export interface LoopbackReceived {
  from: string;
  subject: string;
  autoSubmitted: string | null;
  /**
   * The Message-ID the reply answers. It matches the `message_id` of the trigger's stored
   * inbound row for the test, which ties this receipt to that test rather than to any reply.
   */
  inReplyTo: string | null;
  receivedAt: string;
}

export interface LoopbackStatus {
  lastSent: LoopbackSent | null;
  lastReceived: LoopbackReceived | null;
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  try {
    return await kv.get<T>(key, 'json');
  } catch {
    return null;
  }
}

export async function readLoopbackStatus(env: Pick<Env, 'KV'>): Promise<LoopbackStatus> {
  const [lastSent, lastReceived] = await Promise.all([
    readJson<LoopbackSent>(env.KV, LAST_SENT_KEY),
    readJson<LoopbackReceived>(env.KV, LAST_RECEIVED_KEY),
  ]);
  return { lastSent, lastReceived };
}

export async function sendLoopbackTest(
  env: Pick<Env, 'KV' | 'BASE_DOMAIN'>,
  sender: AgentEmailSender,
  to: string,
  now: Date
): Promise<LoopbackSent> {
  const { providerMessageId } = await sender.send({
    from: { email: loopbackAddress(env.BASE_DOMAIN), name: 'SAM loopback test' },
    to,
    subject: `${LOOPBACK_SUBJECT} ${now.toISOString()}`,
    text: LOOPBACK_BODY,
    headers: {},
  });
  const sent: LoopbackSent = { to, sentAt: now.toISOString(), providerMessageId };
  await env.KV.put(LAST_SENT_KEY, JSON.stringify(sent), {
    expirationTtl: LOOPBACK_STATUS_TTL_SECONDS,
  });
  log.info('agent_email.loopback_sent', { to, providerMessageId });
  return sent;
}

export async function recordLoopbackReceipt(
  env: Pick<Env, 'KV'>,
  receipt: LoopbackReceived
): Promise<void> {
  await env.KV.put(LAST_RECEIVED_KEY, JSON.stringify(receipt), {
    expirationTtl: LOOPBACK_STATUS_TTL_SECONDS,
  });
  log.info('agent_email.loopback_received', {
    from: receipt.from,
    autoSubmitted: receipt.autoSubmitted,
  });
}
