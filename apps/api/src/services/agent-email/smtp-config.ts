/**
 * SMTP settings for SAM's own email (sign-in codes) on installs without Cloudflare's Email
 * Sending binding, such as a self-hosted celld box. Operator bootstrap configuration
 * (Worker vars plus the SMTP_PASSWORD secret, written by `scripts/selfhost/mail-settings.ts`):
 * the sender must work before any administrator exists, because the first account signs up by
 * email.
 *
 * Every setting is checked here and an invalid set disables SMTP outright (fail closed):
 * - SMTP_TLS is `starttls` (default), `tls` (implicit TLS) or `none`;
 * - `none` sends in plaintext, so it is accepted only for a loopback host (the box's own mail
 *   collector). A remote relay must use TLS; celld and workerd verify its certificate chain and
 *   hostname (celld trusts only its bundled public roots, so the relay needs a public CA);
 * - SMTP_USERNAME and SMTP_PASSWORD come together or not at all;
 * - SMTP_FROM is required: the relay decides which senders it accepts, so SAM cannot guess.
 */
export type SmtpTlsMode = 'starttls' | 'tls' | 'none';

/** Submission port for STARTTLS (RFC 6409). */
export const DEFAULT_SMTP_STARTTLS_PORT = 587;
/** Submission port for implicit TLS (RFC 8314). */
export const DEFAULT_SMTP_IMPLICIT_TLS_PORT = 465;

export interface SmtpConfig {
  host: string;
  port: number;
  tls: SmtpTlsMode;
  /** Present only with a password: the client then authenticates with AUTH PLAIN. */
  credentials: { username: string; password: string } | null;
  from: string;
}

/**
 * The settings this module reads. Declared here rather than picked from `Env` so the self-host
 * deploy script (scripts/selfhost/mail-settings.ts) can validate a box's settings with this
 * same function; `Env` satisfies it structurally.
 */
export interface SmtpEnv {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_TLS?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
}

export type SmtpConfigResult =
  | { status: 'absent' }
  | { status: 'invalid'; problem: string }
  | { status: 'ok'; config: SmtpConfig };

/** A hostname, an IPv4 literal, or a bracketed IPv6 literal. */
const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])$/;

/**
 * An ASCII address with no spaces, quotes, angle brackets or control characters: it is written
 * verbatim into `MAIL FROM:<...>` and the From header, so nothing in it may end a command.
 */
export const SMTP_ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const MAX_ADDRESS_LENGTH = 254;

export function isSmtpAddress(value: string): boolean {
  return value.length <= MAX_ADDRESS_LENGTH && SMTP_ADDRESS_PATTERN.test(value);
}

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Hosts plaintext SMTP may go to: only this machine. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

function parseTlsMode(raw: string): SmtpTlsMode | null {
  const mode = raw.toLowerCase() || 'starttls';
  return mode === 'starttls' || mode === 'tls' || mode === 'none' ? mode : null;
}

function parsePort(raw: string, tls: SmtpTlsMode): number | string {
  if (!raw) {
    if (tls === 'starttls') return DEFAULT_SMTP_STARTTLS_PORT;
    if (tls === 'tls') return DEFAULT_SMTP_IMPLICIT_TLS_PORT;
    return 'SMTP_PORT is required when SMTP_TLS is none';
  }
  const port = Number(raw);
  return /^\d{1,5}$/.test(raw) && port >= 1 && port <= 65535
    ? port
    : 'SMTP_PORT must be an integer between 1 and 65535';
}

function parseCredentials(env: SmtpEnv): SmtpConfig['credentials'] | string {
  const username = trimmed(env.SMTP_USERNAME);
  // A password is used exactly as given: surrounding spaces could be part of it.
  const password = env.SMTP_PASSWORD ?? '';
  if (!username && !password) return null;
  if (!username || !password) return 'SMTP_USERNAME and SMTP_PASSWORD must be set together';
  if (/[\0\r\n]/.test(username) || /[\0\r\n]/.test(password)) {
    return 'SMTP_USERNAME and SMTP_PASSWORD must not contain line breaks or NUL';
  }
  return { username, password };
}

/** Never throws. `absent` when SMTP_HOST is unset; `invalid` names the first problem found. */
export function resolveSmtpConfig(env: SmtpEnv): SmtpConfigResult {
  const host = trimmed(env.SMTP_HOST);
  if (!host) return { status: 'absent' };
  const invalid = (problem: string): SmtpConfigResult => ({ status: 'invalid', problem });
  if (host.length > 253 || !HOST_PATTERN.test(host)) {
    return invalid('SMTP_HOST must be a hostname or an IP address');
  }
  const tls = parseTlsMode(trimmed(env.SMTP_TLS));
  if (!tls) return invalid('SMTP_TLS must be starttls, tls or none');
  if (tls === 'none' && !isLoopbackHost(host)) {
    return invalid('SMTP_TLS=none is allowed only for a loopback SMTP_HOST');
  }
  const port = parsePort(trimmed(env.SMTP_PORT), tls);
  if (typeof port === 'string') return invalid(port);
  const credentials = parseCredentials(env);
  if (typeof credentials === 'string') return invalid(credentials);
  const from = trimmed(env.SMTP_FROM).toLowerCase();
  if (!isSmtpAddress(from)) return invalid('SMTP_FROM must be a plain ASCII email address');
  return {
    status: 'ok',
    config: { host: host.replace(/^\[|\]$/g, ''), port, tls, credentials, from },
  };
}
