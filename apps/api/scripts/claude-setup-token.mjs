#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_VERIFICATION_URL_LENGTH = 4096;
const MAX_USER_CODE_LENGTH = 128;
const MAX_CLAUDE_TOKEN_LENGTH = 8192;
const CLAUDE_OAUTH_TOKEN_PREFIX = 'sk-ant-oat';
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const DEVICE_AUTH_STATE_FILE = 'device-auth-state.json';
const CLAUDE_OAUTH_TOKEN_FILE = 'claude-oauth-token.txt';
const VERIFICATION_CODE_FILE = 'verification-code.txt';
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CLAUDE_SETUP_COMMAND =
  'stty cols 512; env DISABLE_AUTOUPDATER=1 NO_COLOR=1 TERM=xterm-256color claude setup-token';
const URL_PATTERN = /https:\/\/[^\s<>'"`]+/gi;
const TOKEN_PATTERN = /\bsk-ant-oat(?:[A-Za-z0-9._-]|\r?\n){16,8192}\b/g;
// The Ink error screen always renders `OAuth error: <message>` and then waits for a
// retry keypress without exiting — treat ANY such marker after the code was
// forwarded as terminal. Requiring a specific status-code suffix here made real
// failures (401 "Authentication failed", state mismatch, network errors) hang
// until the session TTL.
const OAUTH_REJECTION_PATTERN = /OAuth error:/i;
// Ink redraws overwrite characters in place, so the surviving text can drop
// letters and spaces ("Requstfailed withstatus code 400"). Classification
// patterns must tolerate that mangling — match with optional gaps, never on
// exact prose.
const OAUTH_ERROR_LINE_PATTERN = /OAuth error:\s*([^\n\r]*)/gi;
const OAUTH_RETRY_SUFFIX_PATTERN = /Press\s*Enter\s*to\s*retry.*$/i;
const OAUTH_INCOMPLETE_CODE_PATTERN = /invalid\s*c\w{0,3}de/i;
const OAUTH_STATUS_CODE_PATTERN = /status\s*code\s*(\d{3})/i;
const OAUTH_NETWORK_ERROR_PATTERN =
  /(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket|network|fetch\s*fail|tunnel|conn\w{0,4}ion|CONNECT\s*response)/i;
const SECRET_LIKE_PATTERN = /sk-ant[A-Za-z0-9._-]*/gi;
const MAX_OAUTH_ERROR_DETAIL_LENGTH = 160;
const DEFAULT_VERIFICATION_ENTER_DELAY_MS = 1000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 120_000;
const DEFAULT_REJECTION_SETTLE_MS = 400;

function positiveIntFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const CODE_PATTERNS = [
  /(?:verification|one[- ]time|device)?\s*code[^A-Za-z0-9-]{0,40}([A-Z0-9][A-Z0-9-]{3,127})/i,
  /enter\s+(?:this\s+|the\s+)?(?:code\s+)?([A-Z0-9][A-Z0-9-]{3,127})/i,
];
const PROSE_CODE_WORDS = new Set(['HERE', 'TRUE', 'FALSE', 'PROMPTED']);

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
  return url.toString();
}

export function validateClaudeOauthToken(value) {
  const token = value.trim();
  if (!token.startsWith(CLAUDE_OAUTH_TOKEN_PREFIX)) {
    throw new Error('Claude setup-token returned an invalid OAuth token prefix');
  }
  if (token.length > MAX_CLAUDE_TOKEN_LENGTH) {
    throw new Error('Claude setup-token returned an overlong OAuth token');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error('Claude setup-token returned an OAuth token with invalid characters');
  }
  return token;
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

export function extractClaudeSetupOutput(raw) {
  const text = stripAnsi(raw);
  let verificationUrl;
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = cleanUrlCandidate(match[0]);
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

  let token;
  TOKEN_PATTERN.lastIndex = 0;
  const tokenMatch = TOKEN_PATTERN.exec(text);
  if (tokenMatch?.[0]) token = validateClaudeOauthToken(tokenMatch[0].replace(/\s+/g, ''));

  return { verificationUrl, userCode, token };
}

/**
 * Pull the last rendered `OAuth error: <message>` line out of the (ANSI-stripped)
 * CLI output and reduce it to a short, non-secret diagnostic. The wording is the
 * only signal distinguishing an incomplete paste, a server 4xx, and a sandbox
 * network failure — discarding it turns every failure into "code rejected".
 */
export function extractOauthErrorDetail(text) {
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
    .slice(0, MAX_OAUTH_ERROR_DETAIL_LENGTH);
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
  if (OAUTH_STATUS_CODE_PATTERN.test(text)) {
    return { code: 'code_rejected', message: 'Claude rejected the verification code' };
  }
  if (OAUTH_NETWORK_ERROR_PATTERN.test(text)) {
    return {
      code: 'exchange_network_error',
      message: 'Claude sign-in failed with a network error during the code exchange',
    };
  }
  return { code: 'code_rejected', message: 'Claude rejected the verification code' };
}

export async function runClaudeSetupToken({
  statePath,
  credentialPath,
  verificationCodePath,
  spawnProcess = spawn,
  onSpawn,
  writeState,
  writeCredential,
  readVerificationCode = (path) => readFile(path, 'utf8'),
  deleteVerificationCode = unlink,
  verificationCodePollMs = 500,
  verificationEnterDelayMs = positiveIntFromEnv(
    'CLAUDE_SETUP_ENTER_DELAY_MS',
    DEFAULT_VERIFICATION_ENTER_DELAY_MS
  ),
  exchangeTimeoutMs = positiveIntFromEnv(
    'CLAUDE_SETUP_EXCHANGE_TIMEOUT_MS',
    DEFAULT_EXCHANGE_TIMEOUT_MS
  ),
  rejectionSettleMs = positiveIntFromEnv(
    'CLAUDE_SETUP_REJECTION_SETTLE_MS',
    DEFAULT_REJECTION_SETTLE_MS
  ),
}) {
  const setupPaths = resolveClaudeSetupPaths({ statePath, credentialPath, verificationCodePath });
  const writeStateFile =
    writeState ??
    (async (state) => {
      await writeFile(setupPaths.temporaryStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(setupPaths.temporaryStatePath, setupPaths.statePath);
    });
  const writeCredentialFile =
    writeCredential ??
    (async (token) => {
      await writeFile(setupPaths.temporaryCredentialPath, `${token}\n`, { mode: 0o600 });
      await rename(setupPaths.temporaryCredentialPath, setupPaths.credentialPath);
    });

  // Claude Code only prints the setup-token browser URL on a TTY. The
  // Cloudflare Sandbox exec API is non-interactive, so run it through
  // `script` to allocate a pseudo-terminal while still capturing stdout/stderr
  // for non-secret URL/token parsing. The transcript path is /dev/null so no
  // token-bearing terminal log is persisted.
  const claude = spawnProcess('script', ['-qfec', CLAUDE_SETUP_COMMAND, '/dev/null'], {
    env: {
      ...process.env,
      DISABLE_AUTOUPDATER: '1',
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  onSpawn?.(claude);

  let publishedWaiting = false;
  let verificationCodeForwarded = false;
  let tokenCaptured = false;
  let terminalStatePublished = false;
  let verificationCodePoll;
  let verificationEnterTimer;
  let exchangeDeadlineTimer;
  let rejectionSettleTimer;
  let outputBuffer = '';
  let stateWriteQueue = Promise.resolve();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  function settleReady(error) {
    if (settled) return;
    settled = true;
    if (error) rejectReady(error);
    else resolveReady(claude);
  }

  function publishState(state) {
    const isTerminal = state.status === 'completed' || state.status === 'failed';
    if (terminalStatePublished) return stateWriteQueue;
    if (isTerminal) terminalStatePublished = true;
    stateWriteQueue = stateWriteQueue.then(() => writeStateFile(state));
    return stateWriteQueue;
  }

  function clearForwardingTimers() {
    if (verificationCodePoll) clearInterval(verificationCodePoll);
    verificationCodePoll = undefined;
    if (verificationEnterTimer) clearTimeout(verificationEnterTimer);
    verificationEnterTimer = undefined;
    if (exchangeDeadlineTimer) clearTimeout(exchangeDeadlineTimer);
    exchangeDeadlineTimer = undefined;
    if (rejectionSettleTimer) clearTimeout(rejectionSettleTimer);
    rejectionSettleTimer = undefined;
  }

  function publishFailure(message, code, detail) {
    clearForwardingTimers();
    void publishState({
      status: 'failed',
      error: message,
      ...(code ? { code } : {}),
      ...(detail ? { detail } : {}),
    }).finally(() => {
      settleReady(new Error(message));
    });
  }

  function maybePublishWaiting(details) {
    if (publishedWaiting || !details.verificationUrl) return;
    publishedWaiting = true;
    void publishState({
      status: 'waiting_for_user',
      verificationUrl: details.verificationUrl,
      userCode: details.userCode ?? null,
    }).then(() => {
      verificationCodePoll = setInterval(async () => {
        try {
          const code = await readVerificationCode(setupPaths.verificationCodePath);
          await deleteVerificationCode(setupPaths.verificationCodePath);
          clearInterval(verificationCodePoll);
          verificationCodePoll = undefined;
          verificationCodeForwarded = true;
          // Claude Code's interactive prompt treats one large stdin chunk as a
          // paste and absorbs a trailing carriage return instead of submitting
          // (reproduced with ~100-char real codes; short test codes submit).
          // Write the code, then send Enter as a SEPARATE write after a settle
          // delay so the CLI registers a real submit keypress.
          claude.stdin.write(code.replace(/\s+/g, ''));
          verificationEnterTimer = setTimeout(() => {
            verificationEnterTimer = undefined;
            claude.stdin.write('\r');
            // The exchange is a bounded HTTP round-trip: any outcome the parser
            // does not recognize (unknown error wording, hung request) must fail
            // visibly instead of stalling until the session TTL.
            exchangeDeadlineTimer = setTimeout(() => {
              exchangeDeadlineTimer = undefined;
              publishFailure(
                'Claude did not finish the verification code exchange in time',
                'exchange_timeout'
              );
              claude.kill('SIGTERM');
            }, exchangeTimeoutMs);
          }, verificationEnterDelayMs);
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            publishFailure('Claude verification code could not be forwarded');
            claude.kill('SIGTERM');
          }
        }
      }, verificationCodePollMs);
      settleReady();
    });
  }

  function maybeCaptureToken(details) {
    if (tokenCaptured || !details.token) return;
    tokenCaptured = true;
    clearForwardingTimers();
    void writeCredentialFile(details.token)
      .then(() => publishState({ status: 'completed' }))
      .then(() => settleReady())
      .then(() => claude.kill('SIGTERM'))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        publishFailure(message);
        claude.kill('SIGTERM');
      });
  }

  function processOutput(chunk) {
    outputBuffer = `${outputBuffer}${chunk}`.slice(-32768);
    let details;
    try {
      details = extractClaudeSetupOutput(outputBuffer);
    } catch (error) {
      publishFailure(error instanceof Error ? error.message : String(error));
      claude.kill('SIGTERM');
      return;
    }
    maybePublishWaiting(details);
    if (
      verificationCodeForwarded &&
      !rejectionSettleTimer &&
      OAUTH_REJECTION_PATTERN.test(stripAnsi(outputBuffer))
    ) {
      // The error screen can arrive across several PTY chunks; wait one settle
      // window so the captured detail is the complete rendered line, then
      // classify it so the control plane can distinguish an incomplete paste,
      // a server rejection, and a sandbox network failure.
      rejectionSettleTimer = setTimeout(() => {
        rejectionSettleTimer = undefined;
        const detail = extractOauthErrorDetail(stripAnsi(outputBuffer));
        const { code, message } = classifyOauthError(detail);
        publishFailure(message, code, detail);
        claude.kill('SIGTERM');
      }, rejectionSettleMs);
      return;
    }
    maybeCaptureToken(details);
  }

  claude.stdout.on('data', processOutput);
  claude.stderr.on('data', processOutput);

  claude.on('error', (error) => {
    publishFailure(error.message);
  });
  claude.on('exit', (code, signal) => {
    if (tokenCaptured) return;
    publishFailure(`Claude setup-token exited before returning a token (${code ?? signal})`);
  });

  await publishState({ status: 'starting' });
  return ready;
}

export function runClaudeSetupTokenCli(argv = process.argv, runner = runClaudeSetupToken) {
  const statePath = argv[2];
  const credentialPath = argv[3];
  const verificationCodePath = argv[4];
  if (!statePath || !credentialPath || !verificationCodePath) {
    process.stderr.write(
      'Usage: claude-setup-token.mjs <state-path> <credential-path> <verification-code-path>\n'
    );
    process.exitCode = 2;
    return;
  }

  return runner({
    statePath,
    credentialPath,
    verificationCodePath,
    onSpawn: (claude) => {
      process.once('SIGTERM', () => claude.kill('SIGTERM'));
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  Promise.resolve(runClaudeSetupTokenCli()).catch(() => {
    process.exitCode = 1;
  });
}
