import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractClaudeSetupOutput,
  resolveClaudeSetupPaths,
  runClaudeSetupToken,
  runClaudeSetupTokenCli,
  validateClaudeOauthToken,
  validateClaudeVerificationUrl,
} from '../../../scripts/claude-setup-token.mjs';

function fakeClaudeProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    stdin: PassThrough;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn();
  process.stdin = new PassThrough();
  return process;
}

const CLAUDE_TOKEN = `sk-ant-oat${'A'.repeat(48)}`;
const CLAUDE_SETUP_HOME = '/tmp/sam-claude-setup-test';
const CLAUDE_STATE_PATH = `${CLAUDE_SETUP_HOME}/device-auth-state.json`;
const CLAUDE_CREDENTIAL_PATH = `${CLAUDE_SETUP_HOME}/claude-oauth-token.txt`;
const CLAUDE_VERIFICATION_CODE_PATH = `${CLAUDE_SETUP_HOME}/verification-code.txt`;

function validSetupPaths() {
  vi.stubEnv('CLAUDE_CONFIG_DIR', CLAUDE_SETUP_HOME);
  return {
    statePath: CLAUDE_STATE_PATH,
    credentialPath: CLAUDE_CREDENTIAL_PATH,
    verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Claude setup-token driver', () => {
  it('extracts a trusted Claude URL, optional verification code, and OAuth token', () => {
    const output = extractClaudeSetupOutput(
      `\u001b[32mOpen https://claude.com/cai/oauth/authorize?code=abc.\u001b[0m\nVerification code: ABCD-EFGH\nToken: ${CLAUDE_TOKEN}`
    );

    expect(output).toEqual({
      verificationUrl: 'https://claude.com/cai/oauth/authorize?code=abc',
      userCode: 'ABCD-EFGH',
      token: CLAUDE_TOKEN,
    });
  });

  it('joins a token wrapped by the PTY instead of accepting a truncated fragment', () => {
    const wrapped = `${CLAUDE_TOKEN.slice(0, 28)}\n${CLAUDE_TOKEN.slice(28)}`;
    expect(extractClaudeSetupOutput(`Your token: ${wrapped}`).token).toBe(CLAUDE_TOKEN);
  });

  it('extracts URLs from Claude terminal hyperlink output', () => {
    const output = extractClaudeSetupOutput(
      '\u001b]8;id=abc;https://claude.com/cai/oauth/authorize?code=abc&state=def\u0007' +
        'https://claude.com/cai/oauth/authorize?code=abc&state=def' +
        '\u001b]8;;\u0007\nPaste code here if prompted >'
    );

    expect(output.verificationUrl).toBe(
      'https://claude.com/cai/oauth/authorize?code=abc&state=def'
    );
    expect(output.userCode).toBeUndefined();
  });

  it('does not treat URL query parameters or Claude prompt prose as a user code', () => {
    const output = extractClaudeSetupOutput(
      'Open https://claude.com/cai/oauth/authorize?code=true&state=def\n' +
        'Paste code here if prompted >'
    );

    expect(output.verificationUrl).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=def'
    );
    expect(output.userCode).toBeUndefined();
  });

  it('accepts Anthropic-owned auth hosts and rejects untrusted hosts', () => {
    expect(validateClaudeVerificationUrl('https://claude.com/cai/oauth/authorize')).toBe(
      'https://claude.com/cai/oauth/authorize'
    );
    expect(validateClaudeVerificationUrl('https://console.anthropic.com/oauth')).toBe(
      'https://console.anthropic.com/oauth'
    );
    expect(() => validateClaudeVerificationUrl('https://example.com/oauth')).toThrow(
      /untrusted verification URL/
    );
  });

  it('requires Claude OAuth token shape for captured credentials', () => {
    expect(validateClaudeOauthToken(CLAUDE_TOKEN)).toBe(CLAUDE_TOKEN);
    expect(() => validateClaudeOauthToken('sk-ant-api03-not-oauth')).toThrow(/invalid OAuth token/);
  });

  it('derives setup file paths from CLAUDE_CONFIG_DIR and rejects path escapes', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', CLAUDE_SETUP_HOME);

    expect(
      resolveClaudeSetupPaths({
        statePath: CLAUDE_STATE_PATH,
        credentialPath: CLAUDE_CREDENTIAL_PATH,
        verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
      })
    ).toEqual({
      statePath: CLAUDE_STATE_PATH,
      temporaryStatePath: `${CLAUDE_SETUP_HOME}/device-auth-state.json.tmp`,
      credentialPath: CLAUDE_CREDENTIAL_PATH,
      verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
      temporaryCredentialPath: `${CLAUDE_SETUP_HOME}/claude-oauth-token.txt.tmp`,
    });

    expect(() =>
      resolveClaudeSetupPaths({
        statePath: `${CLAUDE_SETUP_HOME}/../device-auth-state.json`,
        credentialPath: CLAUDE_CREDENTIAL_PATH,
        verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
      })
    ).toThrow(/expected setup state file/);
    expect(() =>
      resolveClaudeSetupPaths({
        statePath: CLAUDE_STATE_PATH,
        credentialPath: `${CLAUDE_SETUP_HOME}/../claude-oauth-token.txt`,
        verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
      })
    ).toThrow(/expected OAuth token file/);
    expect(() =>
      resolveClaudeSetupPaths({
        statePath: '/device-auth-state.json',
        credentialPath: '/claude-oauth-token.txt',
        verificationCodePath: '/verification-code.txt',
        configDir: '/',
      })
    ).toThrow(/must not resolve to the filesystem root/);
  });

  it('forwards all three executable arguments into the driver', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);

    await runClaudeSetupTokenCli(
      [
        'node',
        'claude-setup-token.mjs',
        CLAUDE_STATE_PATH,
        CLAUDE_CREDENTIAL_PATH,
        CLAUDE_VERIFICATION_CODE_PATH,
      ],
      runner
    );

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        statePath: CLAUDE_STATE_PATH,
        credentialPath: CLAUDE_CREDENTIAL_PATH,
        verificationCodePath: CLAUDE_VERIFICATION_CODE_PATH,
      })
    );
  });

  it('publishes non-secret actionable state and writes only the token to the credential file', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];
    const credentials: string[] = [];
    let spawnedCommand = '';
    let spawnedArgs: string[] = [];

    const ready = runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: (command, args) => {
        spawnedCommand = command;
        spawnedArgs = args;
        return fake;
      },
      writeState: async (state) => states.push(state),
      writeCredential: async (token) => credentials.push(token),
      readVerificationCode: vi.fn().mockResolvedValue(' abc 123#state\n'),
      deleteVerificationCode: vi.fn().mockResolvedValue(undefined),
      verificationCodePollMs: 1,
      verificationEnterDelayMs: 1,
    });

    expect(spawnedCommand).toBe('script');
    expect(spawnedArgs).toEqual([
      '-qfec',
      expect.stringContaining('claude setup-token'),
      '/dev/null',
    ]);

    fake.stderr.write('Open https://claude.com/cai/oauth/authorize\n');
    await ready;

    expect(states).toEqual([
      { status: 'starting' },
      {
        status: 'waiting_for_user',
        verificationUrl: 'https://claude.com/cai/oauth/authorize',
        userCode: null,
      },
    ]);
    expect(JSON.stringify(states)).not.toContain(CLAUDE_TOKEN);
    // The code and the Enter keypress MUST be separate stdin writes: Claude
    // Code's prompt treats one large chunk as a paste and absorbs an inline
    // trailing \r, leaving the code typed but never submitted.
    const stdinWrites: string[] = [];
    fake.stdin.on('data', (chunk) => stdinWrites.push(chunk.toString()));
    await vi.waitFor(() => expect(stdinWrites).toEqual(['abc123#state', '\r']));

    fake.stdout.write(`Your token: ${CLAUDE_TOKEN}\n`);
    await vi.waitFor(() => expect(credentials).toEqual([CLAUDE_TOKEN]));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'completed' }));
    expect(JSON.stringify(states)).not.toContain(CLAUDE_TOKEN);
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('publishes a sanitized failure when Claude rejects a forwarded code but stays open', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];

    const ready = runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
      readVerificationCode: vi.fn().mockResolvedValue('garbage#rejected-code'),
      deleteVerificationCode: vi.fn().mockResolvedValue(undefined),
      verificationCodePollMs: 1,
      verificationEnterDelayMs: 1,
    });

    fake.stdout.write('Open https://claude.com/cai/oauth/authorize\n');
    await ready;
    const stdinWrites: string[] = [];
    fake.stdin.on('data', (chunk) => stdinWrites.push(chunk.toString()));
    await vi.waitFor(() => expect(stdinWrites).toEqual(['garbage#rejected-code', '\r']));
    fake.stdout.write('OAuth error: Request failed with status code 400\nPress Enter to retry.');

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        status: 'failed',
        error: 'Claude rejected the verification code',
      })
    );
    expect(JSON.stringify(states)).not.toContain('garbage#rejected-code');
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('submits realistic-length codes even though the CLI paste widget absorbs an inline carriage return', async () => {
    // Discriminating regression for the 2026-07-26 production hang: model the
    // real Claude Code prompt, which inserts a large single chunk as pasted
    // TEXT (an inline trailing \r is absorbed, not executed) and only submits
    // on a subsequent standalone Enter keypress. The pre-fix driver (one
    // `code\r` write) never submits here and this test times out.
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];
    const realisticCode = `${'A'.repeat(60)}#${'B'.repeat(43)}`;
    let pastedBuffer = '';

    fake.stdin.on('data', (chunk) => {
      const text = chunk.toString();
      if (text === '\r' && pastedBuffer.length > 0) {
        // Standalone Enter after pasted text: the CLI submits and the exchange
        // fails upstream (invalid test code), rendering the Ink error screen.
        fake.stdout.write('OAuth error: Request failed with status code 400\nPress Enter to retry.');
        return;
      }
      // Large chunk (with or without inline \r): inserted as text, not submitted.
      pastedBuffer += text.replace(/\r/g, '');
    });

    const ready = runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
      readVerificationCode: vi.fn().mockResolvedValue(realisticCode),
      deleteVerificationCode: vi.fn().mockResolvedValue(undefined),
      verificationCodePollMs: 1,
      verificationEnterDelayMs: 5,
    });

    fake.stdout.write('Open https://claude.com/cai/oauth/authorize\n');
    await ready;

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        status: 'failed',
        error: 'Claude rejected the verification code',
      })
    );
    expect(pastedBuffer).toBe(realisticCode);
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('treats any post-forward OAuth error screen as terminal, not only status-code wordings', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];

    const ready = runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
      readVerificationCode: vi.fn().mockResolvedValue('expired#code'),
      deleteVerificationCode: vi.fn().mockResolvedValue(undefined),
      verificationCodePollMs: 1,
      verificationEnterDelayMs: 1,
    });

    fake.stdout.write('Open https://claude.com/cai/oauth/authorize\n');
    await ready;
    const stdinWrites: string[] = [];
    fake.stdin.on('data', (chunk) => stdinWrites.push(chunk.toString()));
    await vi.waitFor(() => expect(stdinWrites).toEqual(['expired#code', '\r']));
    // Real 401 wording from claude v2.1.220 — contains no "status code" suffix.
    fake.stdout.write(
      'OAuth error: Authentication failed: Invalid authorization code\nPress Enter to retry.'
    );

    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        status: 'failed',
        error: 'Claude rejected the verification code',
      })
    );
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails fast with exchange_timeout when the exchange produces no recognizable outcome', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];

    runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
      readVerificationCode: vi.fn().mockResolvedValue('hung#exchange'),
      deleteVerificationCode: vi.fn().mockResolvedValue(undefined),
      verificationCodePollMs: 1,
      verificationEnterDelayMs: 1,
      exchangeTimeoutMs: 25,
    });

    fake.stdout.write('Open https://claude.com/cai/oauth/authorize\n');
    // The CLI accepts the code + Enter and then goes silent (hung request,
    // unknown error wording, dead spinner): the driver must not stall until the
    // session TTL.
    await vi.waitFor(() =>
      expect(states.at(-1)).toEqual({
        status: 'failed',
        error: 'Claude did not finish the verification code exchange in time',
        code: 'exchange_timeout',
      })
    );
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails safely when the CLI exits before returning an OAuth token', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];

    const ready = runClaudeSetupToken({
      ...validSetupPaths(),
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
    });

    fake.emit('exit', 1, null);

    await expect(ready).rejects.toThrow(/exited before returning a token/);
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
  });
});
