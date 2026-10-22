// =============================================================================
// Agent email (prototype): email-trigger addresses and limits.
//
// An email trigger's address is
//   `${AGENT_EMAIL_LOCAL_PART}+<key>@${AGENT_EMAIL_SUBDOMAIN_LABEL}.<BASE_DOMAIN>`.
// One Email Routing rule routes `agent@` to the API Worker; subaddressing maps each
// `agent+<key>@` address onto it. scripts/deploy/configure-agent-email.ts mirrors the
// two naming constants (a quality test asserts they match).
// The limits below are defaults for the admin settings `agentEmail.*`.
// =============================================================================

/** Subdomain label under BASE_DOMAIN that receives and sends agent email. */
export const AGENT_EMAIL_SUBDOMAIN_LABEL = 'mail';

/** Local part of the single routed address; each trigger is a subaddress of it. */
export const AGENT_EMAIL_LOCAL_PART = 'agent';

/** Length of a trigger's random address key (Crockford base32, 5 bits per character). */
export const AGENT_EMAIL_ADDRESS_KEY_LENGTH = 16;

/** Allowed-sender entries one email trigger may list. */
export const DEFAULT_AGENT_EMAIL_MAX_ALLOWED_SENDERS = 20;

/** Largest inbound message, in bytes, the Worker will read. */
export const DEFAULT_AGENT_EMAIL_MAX_INBOUND_BYTES = 5 * 1024 * 1024;

/** Characters of an email body placed into the agent's prompt. */
export const DEFAULT_AGENT_EMAIL_MAX_BODY_CHARS = 12_000;

/** Longest reply body, in characters, an agent may send. */
export const DEFAULT_AGENT_EMAIL_MAX_REPLY_CHARS = 20_000;

/** Replies an agent may send from one email-triggered run. */
export const DEFAULT_AGENT_EMAIL_MAX_REPLIES_PER_RUN = 5;
