/**
 * Agent email addresses (prototype). Each email trigger owns a subaddress of one routed
 * address: `agent+<key>@agents.<BASE_DOMAIN>`. Cloudflare Email Routing matches the single
 * `agent@` rule (subaddressing on) and keeps the `+<key>` detail in the envelope recipient.
 */
import {
  AGENT_EMAIL_ADDRESS_KEY_LENGTH,
  AGENT_EMAIL_LOCAL_PART,
  AGENT_EMAIL_SUBDOMAIN_LABEL,
  type AgentEmailConfigResponse,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';

/** Crockford base32, lower-cased: no i, l, o or u. 32 symbols, so a byte maps without bias. */
const ADDRESS_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const KEY_PATTERN = new RegExp(`^[${ADDRESS_ALPHABET}]{${AGENT_EMAIL_ADDRESS_KEY_LENGTH}}$`);

/** Detail reserved for the admin loopback test. Never a valid trigger key (wrong length). */
export const LOOPBACK_DETAIL = 'loopback';

export type AgentEmailRecipient = { kind: 'trigger'; key: string } | { kind: 'loopback' };

export function agentEmailDomain(baseDomain: string): string {
  return `${AGENT_EMAIL_SUBDOMAIN_LABEL}.${baseDomain.trim().toLowerCase()}`;
}

/** Agent email is available only when the deploy verified routing and sending. */
export function isAgentEmailAvailable(env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>): boolean {
  return Boolean(env.AGENT_EMAIL && env.BASE_DOMAIN?.trim());
}

export function agentEmailConfig(
  env: Pick<Env, 'AGENT_EMAIL' | 'BASE_DOMAIN'>
): AgentEmailConfigResponse {
  const enabled = isAgentEmailAvailable(env);
  return { enabled, domain: enabled ? agentEmailDomain(env.BASE_DOMAIN) : null };
}

export function generateAddressKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AGENT_EMAIL_ADDRESS_KEY_LENGTH));
  return Array.from(bytes, (byte) => ADDRESS_ALPHABET[byte % ADDRESS_ALPHABET.length]).join('');
}

export function agentEmailAddress(baseDomain: string, detail: string): string {
  return `${AGENT_EMAIL_LOCAL_PART}+${detail}@${agentEmailDomain(baseDomain)}`;
}

export function loopbackAddress(baseDomain: string): string {
  return agentEmailAddress(baseDomain, LOOPBACK_DETAIL);
}

/**
 * Classify an envelope recipient. Anything that is not exactly
 * `agent+<key>@agents.<BASE_DOMAIN>` or the loopback address returns null.
 */
export function parseAgentEmailRecipient(
  recipient: string,
  baseDomain: string
): AgentEmailRecipient | null {
  const normalized = recipient.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || normalized.slice(at + 1) !== agentEmailDomain(baseDomain)) return null;
  const local = normalized.slice(0, at);
  const prefix = `${AGENT_EMAIL_LOCAL_PART}+`;
  if (!local.startsWith(prefix)) return null;
  const detail = local.slice(prefix.length);
  if (detail === LOOPBACK_DETAIL) return { kind: 'loopback' };
  return KEY_PATTERN.test(detail) ? { kind: 'trigger', key: detail } : null;
}

/** Lower-case and lightly validate a mailbox address; returns null when it is not one. */
export function normalizeMailbox(address: string | null | undefined): string | null {
  const value = address?.trim().toLowerCase() ?? '';
  if (value.length < 3 || value.length > 254) return null;
  if (/[\s<>()[\]\\,;:"]/.test(value)) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1 || value.indexOf('@') !== at) return null;
  return value;
}
