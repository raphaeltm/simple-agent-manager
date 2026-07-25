import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  extractClaudeSetupOutput,
  runClaudeSetupToken,
  validateClaudeOauthToken,
  validateClaudeVerificationUrl,
} from '../../../scripts/claude-setup-token.mjs';

function fakeClaudeProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = vi.fn();
  return process;
}

const CLAUDE_TOKEN = `sk-ant-oat${'A'.repeat(48)}`;

describe('Claude setup-token driver', () => {
  it('extracts a trusted Claude URL, optional verification code, and OAuth token', () => {
    const output = extractClaudeSetupOutput(
      `\u001b[32mOpen https://claude.ai/oauth/authorize?code=abc.\u001b[0m\nVerification code: ABCD-EFGH\nToken: ${CLAUDE_TOKEN}`
    );

    expect(output).toEqual({
      verificationUrl: 'https://claude.ai/oauth/authorize?code=abc',
      userCode: 'ABCD-EFGH',
      token: CLAUDE_TOKEN,
    });
  });

  it('accepts Anthropic-owned auth hosts and rejects untrusted hosts', () => {
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

  it('publishes non-secret actionable state and writes only the token to the credential file', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];
    const credentials: string[] = [];

    const ready = runClaudeSetupToken({
      statePath: '/unused-state',
      credentialPath: '/unused-token',
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: async (token) => credentials.push(token),
    });

    fake.stderr.write('Open https://claude.ai/oauth/device\n');
    await ready;

    expect(states).toEqual([
      { status: 'starting' },
      {
        status: 'waiting_for_user',
        verificationUrl: 'https://claude.ai/oauth/device',
        userCode: null,
      },
    ]);
    expect(JSON.stringify(states)).not.toContain(CLAUDE_TOKEN);

    fake.stdout.write(`Your token: ${CLAUDE_TOKEN}\n`);
    await vi.waitFor(() => expect(credentials).toEqual([CLAUDE_TOKEN]));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'completed' }));
    expect(JSON.stringify(states)).not.toContain(CLAUDE_TOKEN);
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails safely when the CLI exits before returning an OAuth token', async () => {
    const fake = fakeClaudeProcess();
    const states: Array<Record<string, unknown>> = [];

    const ready = runClaudeSetupToken({
      statePath: '/unused-state',
      credentialPath: '/unused-token',
      spawnProcess: () => fake,
      writeState: async (state) => states.push(state),
      writeCredential: vi.fn().mockResolvedValue(undefined),
    });

    fake.emit('exit', 1, null);

    await expect(ready).rejects.toThrow(/exited before returning a token/);
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
  });
});
