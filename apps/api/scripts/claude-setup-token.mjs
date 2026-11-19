#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  utf8Tail,
  positiveIntFromEnv,
  resolveClaudeSetupPaths,
  extractClaudeSetupOutput,
  stripAnsi,
  extractOauthErrorDetail,
  classifyOauthError,
  safeOauthDetail,
  CLAUDE_SETUP_COMMAND,
  DEFAULT_VERIFICATION_CODE_POLL_MS,
  DEFAULT_TTY_COLUMNS,
  DEFAULT_OUTPUT_BUFFER_BYTES,
  DEFAULT_VERIFICATION_CODE_MAX_LENGTH,
  DEFAULT_VERIFICATION_ENTER_DELAY_MS,
  DEFAULT_EXCHANGE_TIMEOUT_MS,
  DEFAULT_REJECTION_SETTLE_MS,
  OAUTH_REJECTION_PATTERN,
} from './claude-setup-protocol.mjs';
export * from './claude-setup-protocol.mjs';

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
  verificationCodePollMs = positiveIntFromEnv(
    'CLAUDE_SETUP_VERIFICATION_POLL_MS',
    DEFAULT_VERIFICATION_CODE_POLL_MS
  ),
  ttyColumns = positiveIntFromEnv('CLAUDE_SETUP_TTY_COLUMNS', DEFAULT_TTY_COLUMNS),
  outputBufferBytes = positiveIntFromEnv(
    'CLAUDE_SETUP_OUTPUT_BUFFER_BYTES',
    DEFAULT_OUTPUT_BUFFER_BYTES
  ),
  verificationCodeMaxLength = positiveIntFromEnv(
    'CLAUDE_VERIFICATION_CODE_MAX_LENGTH',
    DEFAULT_VERIFICATION_CODE_MAX_LENGTH
  ),
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

  // `script` provides the TTY required by setup-token without retaining a
  // transcript. A version marker contains no account or authorization data.
  const claude = spawnProcess(
    'script',
    [
      '-qfec',
      `stty cols ${ttyColumns}; printf 'SAM_CLAUDE_VERSION:'; claude --version; ${CLAUDE_SETUP_COMMAND}`,
      '/dev/null',
    ],
    {
      // setup-token's normal Ink renderer emits differential cursor updates.
      // Request supported linear output so tokens arrive as complete lines.
      env: {
        ...process.env,
        DISABLE_AUTOUPDATER: '1',
        NO_COLOR: '1',
        TERM: 'xterm-256color',
        CLAUDE_AX_SCREEN_READER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  onSpawn?.(claude);

  let publishedWaiting = false;
  let authorizationState;
  let verificationCodeForwarded = false;
  let tokenCaptured = false;
  let terminalStatePublished = false;
  let verificationCodePoll;
  let verificationEnterTimer;
  let exchangeDeadlineTimer;
  let rejectionSettleTimer;
  let readInFlight = false;
  let outputBuffer = '';
  let stateWriteQueue = Promise.resolve();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const diagnostics = { startedAt: Date.now() };
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
    if (terminalStatePublished) return stateWriteQueue;
    const terminal = state.status === 'completed' || state.status === 'failed';
    if (terminal) terminalStatePublished = true;
    const snapshot = terminal ? { ...state, diagnostics: { ...diagnostics } } : state;
    stateWriteQueue = stateWriteQueue.then(() => writeStateFile(snapshot));
    // A failed state-file write cannot report through that same file. Stop the
    // child; the control plane TTL remains the fallback. Never leak raw errors.
    void stateWriteQueue.catch(() => {
      clearForwardingTimers();
      terminalStatePublished = true;
      settleReady(new Error('Claude setup state could not be written'));
      claude.kill('SIGTERM');
    });
    return stateWriteQueue;
  }
  function clearForwardingTimers() {
    clearInterval(verificationCodePoll);
    clearTimeout(verificationEnterTimer);
    clearTimeout(exchangeDeadlineTimer);
    clearTimeout(rejectionSettleTimer);
    verificationCodePoll =
      verificationEnterTimer =
      exchangeDeadlineTimer =
      rejectionSettleTimer =
        undefined;
  }
  function publishFailure(message, code, detail) {
    if (terminalStatePublished) return;
    clearForwardingTimers();
    void publishState({
      status: 'failed',
      error: message,
      code,
      ...(detail ? { detail } : {}),
    }).then(
      () => settleReady(new Error(message)),
      () => {}
    );
    claude.kill('SIGTERM');
  }
  function writeInput(value) {
    return new Promise((resolve, reject) => {
      if (terminalStatePublished || diagnostics.exitAt) return reject(new Error('process stopped'));
      claude.stdin.write(value, (error) => (error ? reject(error) : resolve()));
    });
  }
  function failInput() {
    publishFailure('Claude could not receive the verification code', 'stdin_write_failed');
  }
  async function forwardCode() {
    if (readInFlight || terminalStatePublished || diagnostics.exitAt) return;
    readInFlight = true;
    let code;
    try {
      code = await readVerificationCode(setupPaths.verificationCodePath);
      if (terminalStatePublished || diagnostics.exitAt) return;
      diagnostics.codeReadAt = Date.now();
      await deleteVerificationCode(setupPaths.verificationCodePath);
    } catch (error) {
      if (error?.code !== 'ENOENT')
        publishFailure('Claude verification code could not be read', 'code_read_failed');
      return;
    } finally {
      readInFlight = false;
    }
    if (terminalStatePublished || diagnostics.exitAt) return;
    clearInterval(verificationCodePoll);
    verificationCodePoll = undefined;
    const normalized = code.replace(/\s+/g, '');
    if (
      !normalized ||
      normalized.length > verificationCodeMaxLength ||
      !/^[A-Za-z0-9._~#-]+$/.test(normalized)
    ) {
      publishFailure('Claude verification code has an invalid format', 'code_incomplete');
      return;
    }
    const parts = normalized.split('#');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      publishFailure('Copy the complete Claude verification code', 'code_incomplete');
      return;
    }
    if (parts[1] !== authorizationState) {
      publishFailure('The code belongs to a different sign-in attempt', 'code_state_mismatch');
      return;
    }
    diagnostics.stateMatched = true;
    verificationCodeForwarded = true;
    // Bound stalled writes as well as the eventual provider round trip.
    exchangeDeadlineTimer = setTimeout(
      () =>
        publishFailure(
          'Claude did not finish the verification code exchange in time',
          'exchange_timeout'
        ),
      exchangeTimeoutMs
    );
    try {
      await writeInput(normalized);
      if (terminalStatePublished || diagnostics.exitAt) return;
      diagnostics.codeWrittenAt = Date.now();
      verificationEnterTimer = setTimeout(() => {
        verificationEnterTimer = undefined;
        void writeInput('\r').then(() => {
          if (!terminalStatePublished) diagnostics.enterWrittenAt = Date.now();
        }, failInput);
      }, verificationEnterDelayMs);
    } catch {
      failInput();
    }
  }
  function maybePublishWaiting(details) {
    if (
      publishedWaiting ||
      terminalStatePublished ||
      diagnostics.exitAt ||
      !details.verificationUrl
    )
      return;
    publishedWaiting = true;
    authorizationState = new URL(details.verificationUrl).searchParams.get('state');
    diagnostics.urlReadyAt = Date.now();
    void publishState({
      status: 'waiting_for_user',
      verificationUrl: details.verificationUrl,
      userCode: null,
    }).then(
      () => {
        if (terminalStatePublished || diagnostics.exitAt) return;
        verificationCodePoll = setInterval(() => void forwardCode(), verificationCodePollMs);
        settleReady();
      },
      () => {}
    );
  }
  function maybeCaptureToken(details) {
    if (terminalStatePublished || tokenCaptured || !details.token) return;
    tokenCaptured = true;
    clearForwardingTimers();
    diagnostics.tokenCapturedAt = Date.now();
    void writeCredentialFile(details.token)
      .then(() => publishState({ status: 'completed' }))
      .then(() => {
        settleReady();
        claude.kill('SIGTERM');
      })
      .catch(() => publishFailure('Claude token could not be captured', 'credential_write_failed'));
  }
  function publishOauthFailure() {
    const detail = extractOauthErrorDetail(stripAnsi(outputBuffer));
    const { code, message } = classifyOauthError(detail);
    publishFailure(message, code, safeOauthDetail(detail));
  }
  function processOutput(chunk, streamClosed = false) {
    if (terminalStatePublished || tokenCaptured) return;
    outputBuffer = utf8Tail(`${outputBuffer}${chunk}`, outputBufferBytes);
    const version = /SAM_CLAUDE_VERSION:(\d+\.\d+\.\d+)/.exec(stripAnsi(outputBuffer))?.[1];
    if (version) diagnostics.cliVersion = version;
    let details;
    try {
      details = extractClaudeSetupOutput(outputBuffer, ttyColumns, streamClosed);
    } catch {
      publishFailure('Claude sign-in output could not be read', 'output_parse_failed');
      return;
    }
    maybePublishWaiting(details);
    // A token is stronger evidence than old error text left in the PTY buffer.
    maybeCaptureToken(details);
    if (tokenCaptured || terminalStatePublished) return;
    if (verificationCodeForwarded && OAUTH_REJECTION_PATTERN.test(stripAnsi(outputBuffer))) {
      diagnostics.oauthErrorAt ??= Date.now();
      if (streamClosed) publishOauthFailure();
      else if (!rejectionSettleTimer)
        rejectionSettleTimer = setTimeout(publishOauthFailure, rejectionSettleMs);
    }
  }
  claude.stdout.on('data', (chunk) => processOutput(chunk));
  claude.stderr.on('data', (chunk) => processOutput(chunk));
  claude.stdin.on('error', failInput);
  claude.on('error', () =>
    publishFailure('Claude sign-in process could not start', 'process_start_failed')
  );
  claude.on('exit', (code, signal) => {
    diagnostics.exitAt = Date.now();
    if (Number.isInteger(code)) diagnostics.exitCode = code;
    if (typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal)) diagnostics.signal = signal;
    // Do not decide the result here: Node may still deliver stdout after exit.
    clearInterval(verificationCodePoll);
    clearTimeout(verificationEnterTimer);
    clearTimeout(rejectionSettleTimer);
    rejectionSettleTimer = undefined;
  });
  claude.on('close', () => {
    diagnostics.closeAt = Date.now();
    processOutput('', true);
    if (!tokenCaptured && !terminalStatePublished) {
      publishFailure('Claude setup-token exited before returning a token', 'process_exited');
    }
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
