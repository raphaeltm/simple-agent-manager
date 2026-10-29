import { join, parse, resolve } from 'node:path';

export const MAX_VERIFICATION_URL_LENGTH = 4096;
export const MAX_USER_CODE_LENGTH = 128;
export const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const DEVICE_AUTH_STATE_FILE = 'device-auth-state.json';
export const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token.txt';
export const VERIFICATION_CODE_FILE = 'verification-code.txt';
export const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
export const CLAUDE_SETUP_COMMAND =
  'env DISABLE_AUTOUPDATER=1 NO_COLOR=1 TERM=xterm-256color claude setup-token';
export const URL_PATTERN = /https:\/\/[^\s<>'"`]+/gi;
export const TOKEN_PATTERN = /\bsk-ant-oat[A-Za-z0-9._-]{16,}/g;
// The Ink error screen always renders `OAuth error: <message>` and then waits for a
// retry keypress without exiting — treat ANY such marker after the code was
// forwarded as terminal. Requiring a specific status-code suffix here made real
// failures (401 "Authentication failed", state mismatch, network errors) hang
// until the session TTL.
export const OAUTH_REJECTION_PATTERN = /Oa?u?t?h?\s*er?r?o?r?\s*:/i;
// Ink redraws overwrite characters in place, so the surviving text can drop
// letters and spaces ("Requstfailed withstatus code 400"). Classification
// patterns must tolerate that mangling — match with optional gaps, never on
// exact prose.
export const OAUTH_ERROR_LINE_PATTERN = /Oa?u?t?h?\s*er?r?o?r?\s*:\s*([^\n\r]*)/gi;
export const OAUTH_RETRY_SUFFIX_PATTERN = /Press\s*Enter\s*to\s*retry.*$/i;
export const OAUTH_INCOMPLETE_CODE_PATTERN =
  /(?:inv\w{0,5}\s*c\w{0,3}de|full\w{0,3}c\w{0,4}cop\w{0,3})/i;
export const OAUTH_STATUS_CODE_PATTERN = /status\s*code\s*(\d{3})/i;
export const OAUTH_NETWORK_ERROR_PATTERN =
  /(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket|network|fetch\s*fail|tunnel|conn\w{0,4}ion|CONNECT\s*response)/i;
export const SECRET_LIKE_PATTERN = /sk-ant[A-Za-z0-9._-]*/gi;
export const DEFAULT_VERIFICATION_ENTER_DELAY_MS = 1000;
export const DEFAULT_EXCHANGE_TIMEOUT_MS = 120_000;
export const DEFAULT_REJECTION_SETTLE_MS = 400;
export const DEFAULT_VERIFICATION_CODE_POLL_MS = 500;
export const DEFAULT_TTY_COLUMNS = 512;
export const DEFAULT_OUTPUT_BUFFER_BYTES = 32_768;
export const DEFAULT_VERIFICATION_CODE_MAX_LENGTH = 1_024;
export const DEFAULT_OAUTH_ERROR_DETAIL_MAX_LENGTH = 160;
export const DEFAULT_CLAUDE_OAUTH_TOKEN_MAX_LENGTH = 8_192;

export function positiveIntFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
export const CODE_PATTERNS = [
  /(?:verification|one[- ]time|device)?\s*code[^A-Za-z0-9-]{0,40}([A-Z0-9][A-Z0-9-]{3,127})/i,
  /enter\s+(?:this\s+|the\s+)?(?:code\s+)?([A-Z0-9][A-Z0-9-]{3,127})/i,
];
export const PROSE_CODE_WORDS = new Set(['HERE', 'TRUE', 'FALSE', 'PROMPTED']);

function isTrustedClaudeHost(hostname) {
  return (
    hostname === 'claude.com' ||
    hostname.endsWith('.claude.com') ||
    hostname === 'claude.ai' ||
    hostname.endsWith('.claude.ai') ||
    hostname === 'anthropic.com' ||
    hostname.endsWith('.anthropic.com')
  );
}

function cleanUrlCandidate(value) {
  let next = value.trim();
  const controlIndex = next.search(CONTROL_CHARACTER_PATTERN);
  if (controlIndex >= 0) next = next.slice(0, controlIndex);
  while (/[),.;\]]$/.test(next)) next = next.slice(0, -1);
  return next;
}

export function stripAnsi(value) {
  return value.replace(ANSI_ESCAPE_PATTERN, '');
}

export function validateClaudeVerificationUrl(value) {
  if (value.length > MAX_VERIFICATION_URL_LENGTH) {
    throw new Error('Claude setup-token returned an overlong verification URL');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || !isTrustedClaudeHost(url.hostname)) {
    throw new Error('Claude setup-token returned an untrusted verification URL');
  }
  if (
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !['/oauth/authorize', '/cai/oauth/authorize'].includes(url.pathname) ||
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('code_challenge_method') !== 'S256' ||
    ['client_id', 'redirect_uri', 'state', 'code_challenge'].some(
      (key) => url.searchParams.getAll(key).length !== 1 || !url.searchParams.get(key)
    )
  )
    throw new Error('Claude setup-token returned an incomplete authorization URL');
  return url.toString();
}

export function validateClaudeOauthToken(
  value,
  maxLength = positiveIntFromEnv(
    'CLAUDE_OAUTH_TOKEN_MAX_LENGTH',
    DEFAULT_CLAUDE_OAUTH_TOKEN_MAX_LENGTH
  )
) {
  const token = value.trim();
  if (!token.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
    throw new Error('Claude setup-token returned an invalid OAuth token prefix');
  }
  if (token.length > maxLength) {
    throw new Error('Claude setup-token returned an overlong OAuth token');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error('Claude setup-token returned an OAuth token with invalid characters');
  }
  return token;
}

function extractClaudeOauthToken(text, ttyColumns, acceptStreamEnd) {
  TOKEN_PATTERN.lastIndex = 0;
  const match = TOKEN_PATTERN.exec(text);
  if (!match?.[0] || match.index === undefined) return undefined;

  let token = match[0];
  let cursor = match.index + match[0].length;
  let lineStart = text.lastIndexOf('\n', match.index - 1) + 1;

  for (;;) {
    const newlineLength = text.startsWith('\r\n', cursor)
      ? 2
      : text.startsWith('\n', cursor)
        ? 1
        : 0;
    if (newlineLength === 0) {
      if (!acceptStreamEnd && text.slice(cursor) === '\r') return undefined;
      // A token-like suffix at the current end of the stream may still be a
      // partial PTY chunk. Wait for a delimiter before accepting it.
      return cursor === text.length && !acceptStreamEnd ? undefined : token;
    }

    const physicalLineLength = cursor - lineStart;
    if (physicalLineLength < ttyColumns) return token;

    const continuationStart = cursor + newlineLength;
    if (continuationStart === text.length && !acceptStreamEnd) return undefined;
    const continuation = /^[A-Za-z0-9._-]+/.exec(text.slice(continuationStart));
    if (!continuation?.[0]) return token;
    token += continuation[0];
    cursor = continuationStart + continuation[0].length;
    lineStart = continuationStart;
  }
}

export function resolveClaudeSetupPaths({
  statePath,
  credentialPath,
  verificationCodePath,
  configDir = process.env[CLAUDE_CONFIG_DIR_ENV],
}) {
  if (!configDir) {
    throw new Error(`${CLAUDE_CONFIG_DIR_ENV} is required for Claude setup-token`);
  }

  const baseDir = resolve(configDir);
  if (baseDir === parse(baseDir).root) {
    throw new Error(`${CLAUDE_CONFIG_DIR_ENV} must not resolve to the filesystem root`);
  }

  const expectedStatePath = join(baseDir, DEVICE_AUTH_STATE_FILE);
  const expectedCredentialPath = join(baseDir, CLAUDE_OAUTH_TOKEN_FILE);
  const expectedVerificationCodePath = join(baseDir, VERIFICATION_CODE_FILE);

  if (resolve(statePath) !== expectedStatePath) {
    throw new Error('Claude setup-token state path must be the expected setup state file');
  }
  if (resolve(credentialPath) !== expectedCredentialPath) {
    throw new Error('Claude setup-token credential path must be the expected OAuth token file');
  }

  if (resolve(verificationCodePath) !== expectedVerificationCodePath) {
    throw new Error('Claude setup-token verification code path must be the expected setup file');
  }

  return {
    statePath: expectedStatePath,
    temporaryStatePath: join(baseDir, `${DEVICE_AUTH_STATE_FILE}.tmp`),
    credentialPath: expectedCredentialPath,
    verificationCodePath: expectedVerificationCodePath,
    temporaryCredentialPath: join(baseDir, `${CLAUDE_OAUTH_TOKEN_FILE}.tmp`),
  };
}

function validateUserCode(value) {
  const code = value.trim();
  if (
    code.length > MAX_USER_CODE_LENGTH ||
    !/^[A-Z0-9-]{4,}$/.test(code) ||
    PROSE_CODE_WORDS.has(code)
  ) {
    return null;
  }
  return code;
}

export function extractClaudeSetupOutput(
  raw,
  ttyColumns = DEFAULT_TTY_COLUMNS,
  acceptStreamEnd = true
) {
  const text = stripAnsi(raw);
  let verificationUrl;
  // OSC-8 targets are delimited by BEL or ST. Prefer those over wrapped display
  // text; never publish a URL merely because the current PTY chunk ended.
  const hyperlinks = [...raw.matchAll(/\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map(
    (match) => match[1]
  );
  const plain = [...text.matchAll(URL_PATTERN)]
    .filter((match) => match.index + match[0].length < text.length)
    .map((match) => match[0]);
  for (const value of [...hyperlinks, ...plain]) {
    const candidate = cleanUrlCandidate(value);
    try {
      verificationUrl = validateClaudeVerificationUrl(candidate);
      break;
    } catch {
      // Ignore unrelated URLs in CLI output; the driver fails if no trusted URL appears.
    }
  }

  const textWithoutUrls = text.replace(URL_PATTERN, ' ');
  let userCode;
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(textWithoutUrls);
    if (!match?.[1]) continue;
    const candidate = validateUserCode(match[1]);
    if (candidate) {
      userCode = candidate;
      break;
    }
  }

  const tokenCandidate = extractClaudeOauthToken(text, ttyColumns, acceptStreamEnd);
  const token = tokenCandidate ? validateClaudeOauthToken(tokenCandidate) : undefined;

  return { verificationUrl, userCode, token };
}

/**
 * Pull the last rendered `OAuth error: <message>` line out of the (ANSI-stripped)
 * CLI output and reduce it to a short, non-secret diagnostic. The wording is the
 * only signal distinguishing an incomplete paste, a server 4xx, and a sandbox
 * network failure — discarding it turns every failure into "code rejected".
 */
export function extractOauthErrorDetail(
  text,
  maxLength = positiveIntFromEnv(
    'CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH',
    DEFAULT_OAUTH_ERROR_DETAIL_MAX_LENGTH
  )
) {
  let lastLine;
  OAUTH_ERROR_LINE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(OAUTH_ERROR_LINE_PATTERN)) {
    if (match[1]) lastLine = match[1];
  }
  if (!lastLine) return null;
  const detail = lastLine
    .replace(OAUTH_RETRY_SUFFIX_PATTERN, '')
    .replace(SECRET_LIKE_PATTERN, '[redacted]')
    .replace(new RegExp(CONTROL_CHARACTER_PATTERN.source, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return detail || null;
}

/**
 * Classify an OAuth error line into a machine-readable failure class so the
 * control plane can give accurate guidance instead of always claiming the code
 * was rejected.
 */
export function classifyOauthError(detail) {
  const text = detail ?? '';
  if (OAUTH_INCOMPLETE_CODE_PATTERN.test(text)) {
    return {
      code: 'code_incomplete',
      message: 'Claude reported the pasted verification code was incomplete',
    };
  }
  const httpStatus = Number(OAUTH_STATUS_CODE_PATTERN.exec(text)?.[1]);
  if (httpStatus >= 400 && httpStatus < 500 && ![403, 408, 429].includes(httpStatus)) {
    return { code: 'code_rejected', message: 'Claude rejected the verification code' };
  }
  if (httpStatus) {
    return {
      code: 'exchange_provider_error',
      message: 'Claude could not complete the sign-in request',
    };
  }
  if (OAUTH_NETWORK_ERROR_PATTERN.test(text)) {
    return {
      code: 'exchange_network_error',
      message: 'Claude sign-in failed with a network error during the code exchange',
    };
  }
  if (/invalid\s*authorization\s*code/i.test(text)) {
    return { code: 'code_rejected', message: 'Claude rejected the verification code' };
  }
  return { code: 'exchange_failed', message: 'Claude could not complete sign-in' };
}

// Only categories/numeric status survive the sandbox boundary. Never persist
// arbitrary terminal prose: it can contain codes, PKCE parameters or tokens.
export function safeOauthDetail(detail) {
  const status = OAUTH_STATUS_CODE_PATTERN.exec(detail ?? '')?.[1];
  if (status) return `HTTP ${status}`;
  const network = /\b(E[A-Z_]{3,})\b/.exec(detail ?? '')?.[1];
  if (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
    ].includes(network)
  )
    return network;
  return undefined;
}
