/**
 * Email for a celld box: the Worker's SMTP settings and the optional mail collector.
 *
 * The API Worker sends sign-in codes through SMTP when it has no Cloudflare Email Sending binding
 * (apps/api/src/services/agent-email/provider.ts). Two ways to give a box one:
 * - a real relay: SMTP_HOST, SMTP_PORT, SMTP_TLS, SMTP_USERNAME, SMTP_FROM in the compose .env and
 *   SMTP_PASSWORD in .state/secrets.env;
 * - the `mail-collector` compose profile: Mailpit on loopback catches every message and shows it
 *   in a web UI at https://mail.SAM_DOMAIN behind basic auth. Anyone who can read the collector can
 *   sign in as any account, so it is for test installs, off by default, and the deploy refuses
 *   it until `--init` has generated the UI password.
 * Both at once is refused: one install, one place its codes go.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { resolveSmtpConfig } from '../../packages/agent-email/src/smtp-config.js';
import { writePrivateFile } from './secret-files.js';

export const MAIL_COLLECTOR_PROFILE = 'mail-collector';
/** Mailpit's SMTP listener (loopback, no TLS: plaintext SMTP is accepted only to loopback). */
export const DEFAULT_MAIL_COLLECTOR_SMTP_PORT = 1025;
/** Mailpit's web UI (loopback; Caddy publishes it behind basic auth). */
export const DEFAULT_MAIL_COLLECTOR_UI_PORT = 8025;
/** The collector UI is served at <label>.SAM_DOMAIN. */
export const DEFAULT_MAIL_COLLECTOR_HOST_LABEL = 'mail';
/** Basic-auth user name for the collector UI; the password is generated. */
export const MAIL_COLLECTOR_UI_USER = 'collector';
/** Generated UI password length in bytes (hex-encoded, so twice as many characters). */
const UI_PASSWORD_BYTES = 32;
/** File under the state dir holding the generated UI password. */
export const MAIL_COLLECTOR_PASSWORD_FILE = 'mail-collector-ui-password';
/** env_file docker compose gives Caddy (caddy/start.sh, caddy/mail-collector/on.caddy). */
export const MAIL_COLLECTOR_ENV_FILE = 'mail-collector.env';
/** env_file docker compose gives Mailpit: MP_UI_AUTH, its own check of the same credentials. */
export const MAIL_COLLECTOR_UI_ENV_FILE = 'mail-collector-ui.env';

/** Worker vars the box .env may set; SMTP_PASSWORD belongs in secrets.env. */
const SMTP_VAR_NAMES = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_TLS',
  'SMTP_USERNAME',
  'SMTP_FROM',
] as const;

type Box = Readonly<Record<string, string>>;

function port(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return value;
}

export function composeProfiles(box: Box): string[] {
  return (box.COMPOSE_PROFILES ?? '')
    .split(',')
    .map((profile) => profile.trim())
    .filter(Boolean);
}

export function mailCollectorEnabled(box: Box): boolean {
  return composeProfiles(box).includes(MAIL_COLLECTOR_PROFILE);
}

export function mailCollectorPorts(box: Box): { smtp: number; ui: number } {
  const smtp = port(
    box.MAIL_COLLECTOR_SMTP_PORT,
    DEFAULT_MAIL_COLLECTOR_SMTP_PORT,
    'MAIL_COLLECTOR_SMTP_PORT'
  );
  const ui = port(
    box.MAIL_COLLECTOR_UI_PORT,
    DEFAULT_MAIL_COLLECTOR_UI_PORT,
    'MAIL_COLLECTOR_UI_PORT'
  );
  if (smtp === ui)
    throw new Error('MAIL_COLLECTOR_SMTP_PORT and MAIL_COLLECTOR_UI_PORT must differ');
  return { smtp, ui };
}

export function mailCollectorHostLabel(box: Box): string {
  const label = box.MAIL_COLLECTOR_HOST_LABEL || DEFAULT_MAIL_COLLECTOR_HOST_LABEL;
  // One DNS label, never one SAM itself serves (api, app, www, ws-<id>...).
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label) || /^(api|app|www|ws-.*)$/.test(label)) {
    throw new Error(
      'MAIL_COLLECTOR_HOST_LABEL must be one DNS label other than api, app, www, ws-*'
    );
  }
  return label;
}

/**
 * The SMTP Worker vars for this box ({} when it sends no email). Validated with the Worker's own
 * parser, so a setting the Worker would refuse fails the deploy instead of silently turning email
 * sign-in off.
 */
export function smtpWorkerVars(
  box: Box,
  secrets: Readonly<Record<string, string>>,
  baseDomain: string
): Record<string, string> {
  if ('SMTP_PASSWORD' in box) {
    throw new Error(
      'SMTP_PASSWORD is a secret: put it in .state/secrets.env, not the compose .env'
    );
  }
  const configured = Boolean(box.SMTP_HOST?.trim());
  const collector = mailCollectorEnabled(box);
  if (collector && configured) {
    throw new Error(
      `SMTP_HOST is set and the ${MAIL_COLLECTOR_PROFILE} profile is on; choose one place for sign-in codes`
    );
  }
  // A half-applied set would deploy with email sign-in silently off (or silently ignored).
  const relayOnly = SMTP_VAR_NAMES.filter((name) => name !== 'SMTP_FROM' && name !== 'SMTP_HOST');
  const stray = [
    ...(configured || collector ? [] : SMTP_VAR_NAMES.filter((name) => box[name])),
    ...(collector ? relayOnly.filter((name) => box[name]) : []),
    ...(!configured && secrets.SMTP_PASSWORD ? ['SMTP_PASSWORD'] : []),
  ];
  if (stray.length > 0) {
    throw new Error(
      `${stray.join(', ')} set without an SMTP relay (SMTP_HOST); remove it or set SMTP_HOST`
    );
  }
  let vars: Record<string, string> = {};
  if (collector) {
    vars = {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(mailCollectorPorts(box).smtp),
      SMTP_TLS: 'none',
      SMTP_FROM: box.SMTP_FROM || `sign-in@${baseDomain}`,
    };
  } else if (configured) {
    for (const name of SMTP_VAR_NAMES) if (box[name]) vars[name] = box[name];
  } else {
    return {};
  }
  const result = resolveSmtpConfig({ ...vars, SMTP_PASSWORD: secrets.SMTP_PASSWORD });
  if (result.status !== 'ok') {
    throw new Error(
      `SMTP settings: ${result.status === 'invalid' ? result.problem : 'incomplete'}`
    );
  }
  return vars;
}

/**
 * Loopback endpoints celld must be allowed to reach for email: the collector's SMTP port when the
 * profile is on. For the celld egress fence (scripts/selfhost/egress-fence.ts, PR #2641), which
 * adds these to its loopback allowlist. A relay on the internet needs no entry; one on a private
 * address needs SAM_EGRESS_ALLOW.
 */
export function mailEgressEndpoints(box: Box): Array<{ address: string; port: number }> {
  return mailCollectorEnabled(box)
    ? [{ address: '127.0.0.1', port: mailCollectorPorts(box).smtp }]
    : [];
}

/**
 * The collector UI password: generated by `--init` when the profile is on, then kept. Outside
 * `--init` a missing password stops the deploy: the collector must never run without it.
 */
export function ensureMailCollectorPassword(path: string, box: Box, init: boolean): string | null {
  if (!mailCollectorEnabled(box)) return null;
  if (existsSync(path)) {
    const password = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(password)) return password;
    throw new Error(`${path} is not a generated collector password; delete it and run --init`);
  }
  if (!init) {
    throw new Error(
      `the ${MAIL_COLLECTOR_PROFILE} profile is on but ${path} does not exist; run pnpm selfhost:deploy --init first`
    );
  }
  const password = randomBytes(UI_PASSWORD_BYTES).toString('hex');
  writePrivateFile(path, `${password}\n`);
  return password;
}

/** mail-collector.env for Caddy: `off`, or `on` with the UI password, host and port. */
export function renderMailCollectorEnv(box: Box, password: string | null): string {
  const values: Record<string, string> = { SAM_MAIL_COLLECTOR: 'off' };
  if (mailCollectorEnabled(box)) {
    Object.assign(values, {
      SAM_MAIL_COLLECTOR: 'on',
      MAIL_COLLECTOR_HOST_LABEL: mailCollectorHostLabel(box),
      MAIL_COLLECTOR_UI_PORT: String(mailCollectorPorts(box).ui),
      MAIL_COLLECTOR_UI_USER,
      MAIL_COLLECTOR_UI_PASSWORD: generatedPassword(password),
    });
  }
  return dotenv(values);
}

function generatedPassword(password: string | null): string {
  if (!password || !/^[0-9a-f]{64}$/.test(password)) {
    throw new Error('the mail collector needs its generated UI password');
  }
  return password;
}

function dotenv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join('');
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writePrivateFile(path, content);
  return true;
}

/**
 * Writes the collector's env files and returns the paths that changed: mail-collector.env for
 * Caddy (always, so turning the profile off also turns the route off) and, while the profile is
 * on, mail-collector-ui.env for Mailpit's own UI authentication (removed when it is off).
 */
export function writeMailCollectorFiles(
  stateDir: string,
  box: Box,
  password: string | null
): string[] {
  const changed: string[] = [];
  const caddyEnv = join(stateDir, MAIL_COLLECTOR_ENV_FILE);
  if (writeIfChanged(caddyEnv, renderMailCollectorEnv(box, password))) changed.push(caddyEnv);
  const uiEnv = join(stateDir, MAIL_COLLECTOR_UI_ENV_FILE);
  if (mailCollectorEnabled(box)) {
    const auth = dotenv({ MP_UI_AUTH: `${MAIL_COLLECTOR_UI_USER}:${generatedPassword(password)}` });
    if (writeIfChanged(uiEnv, auth)) changed.push(uiEnv);
  } else if (existsSync(uiEnv)) {
    rmSync(uiEnv);
    changed.push(uiEnv);
  }
  return changed;
}
