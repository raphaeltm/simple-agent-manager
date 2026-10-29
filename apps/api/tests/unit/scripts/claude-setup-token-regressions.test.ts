import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractClaudeSetupOutput,
  runClaudeSetupToken,
  utf8Tail,
} from '../../../scripts/claude-setup-token.mjs';

const url =
  'https://claude.ai/oauth/authorize?client_id=test&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=challenge&code_challenge_method=S256&state=expected';
const token = `sk-ant-oat${'X'.repeat(48)}`;
function harness(code = 'synthetic#expected', overrides: Record<string, unknown> = {}) {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/tmp/sam-claude-regression');
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  const states: Array<Record<string, unknown>> = [];
  const writeCredential = vi.fn().mockResolvedValue(undefined);
  const ready = runClaudeSetupToken({
    statePath: '/tmp/sam-claude-regression/device-auth-state.json',
    credentialPath: '/tmp/sam-claude-regression/claude-oauth-token.txt',
    verificationCodePath: '/tmp/sam-claude-regression/verification-code.txt',
    spawnProcess: () => child,
    writeState: async (s) => {
      states.push(s);
    },
    writeCredential,
    readVerificationCode: async () => code,
    deleteVerificationCode: async () => {},
    verificationCodePollMs: 1,
    verificationEnterDelayMs: 1,
    rejectionSettleMs: 30,
    ...overrides,
  });
  const writes: string[] = [];
  child.stdin.on('data', (chunk) => writes.push(chunk.toString()));
  child.stdout.write(`Open ${url}\n`);
  return { child, states, ready, writes, writeCredential };
}
afterEach(() => vi.unstubAllEnvs());
describe('Claude setup-token real-boundary regressions', () => {
  it('bounds multilingual output by UTF-8 bytes without corrupting the suffix', () => {
    const text = '漢😀é'.repeat(100) + 'OAuth error: status code 400';
    for (let limit = 30; limit < 45; limit++) {
      const tail = utf8Tail(text, limit);
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(limit);
      expect(tail).not.toContain('�');
      expect(tail).toContain('OAuth error: status code 400');
    }
  });
  it('never accepts a partial token at any split of wrapped CRLF output', () => {
    const output = `${token.slice(0, 32)}\r\n${token.slice(32)}\r\n`;
    for (let split = 1; split < output.length; split++) {
      const parsed = extractClaudeSetupOutput(output.slice(0, split), 32, false).token;
      expect(parsed === undefined || parsed === token, `split ${split}`).toBe(true);
    }
    expect(extractClaudeSetupOutput(output, 32, false).token).toBe(token);
  });
  it('waits for the continuation when a token chunk ends at a wrapped line', async () => {
    const h = harness('synthetic#expected', { ttyColumns: 32 });
    await h.ready;
    h.child.stdout.write(`${token.slice(0, 32)}\r\n`);
    expect(h.writeCredential).not.toHaveBeenCalled();
    h.child.stdout.write(`${token.slice(32)}\n`);
    await vi.waitFor(() => expect(h.writeCredential).toHaveBeenCalledWith(token));
  });
  it('does not publish an incomplete streamed authorization URL', () => {
    expect(extractClaudeSetupOutput(url.slice(0, -3), 512, false).verificationUrl).toBeUndefined();
  });
  it('ignores documentation URLs and waits for the authorize URL', () => {
    expect(extractClaudeSetupOutput(`https://docs.claude.com/help\n${url}\n`).verificationUrl).toBe(
      url
    );
  });
  it('keeps OAuth failure classification when exit races diagnostic settling', async () => {
    const h = harness();
    await h.ready;
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    h.child.stdout.write('OAuth error: Request failed with status code 400\n');
    h.child.emit('exit', 1, null);
    h.child.emit('close', 1, null);
    await vi.waitFor(() =>
      expect(h.states.at(-1)).toMatchObject({ status: 'failed', code: 'code_rejected' })
    );
  });
  it('drains a final token after exit, including a final chunk without newline', async () => {
    const h = harness();
    await h.ready;
    h.child.emit('exit', 0, null);
    h.child.stdout.write(`Your token: ${token}`);
    h.child.emit('close', 0, null);
    await vi.waitFor(() => expect(h.writeCredential).toHaveBeenCalledWith(token));
    await vi.waitFor(() => expect(h.states.at(-1)).toMatchObject({ status: 'completed' }));
  });
  it('rejects a different login state before sending anything to stdin', async () => {
    const h = harness('synthetic#different');
    await h.ready;
    await vi.waitFor(() =>
      expect(h.states.at(-1)).toMatchObject({ status: 'failed', code: 'code_state_mismatch' })
    );
    expect(h.writes).toEqual([]);
  });
  it('handles an asynchronous stdin error without an uncaught exception', async () => {
    const h = harness();
    await h.ready;
    h.child.stdin.destroy(new Error('private code#state'));
    await vi.waitFor(() => expect(h.states.at(-1)).toMatchObject({ code: 'stdin_write_failed' }));
    expect(JSON.stringify(h.states)).not.toContain('private code#state');
  });
  it('reports a verification file error without forwarding it', async () => {
    const h = harness('unused', {
      readVerificationCode: async () => {
        throw new Error('secret path');
      },
    });
    await h.ready;
    await vi.waitFor(() => expect(h.states.at(-1)).toMatchObject({ code: 'code_read_failed' }));
    expect(h.writes).toEqual([]);
    expect(JSON.stringify(h.states)).not.toContain('secret path');
  });
  it('reports capture IO failures rather than claiming the code was rejected', async () => {
    const h = harness();
    await h.ready;
    h.writeCredential.mockRejectedValueOnce(new Error('private token'));
    h.child.stdout.write(`Your token: ${token}\n`);
    await vi.waitFor(() =>
      expect(h.states.at(-1)).toMatchObject({ code: 'credential_write_failed' })
    );
    expect(JSON.stringify(h.states)).not.toContain(token);
  });
  it('publishes the complete URL after split output and only then accepts input', async () => {
    const full = `${url}\n`;
    for (let i = 1; i < url.length; i++) {
      expect(
        extractClaudeSetupOutput(full.slice(0, i), 512, false).verificationUrl
      ).toBeUndefined();
    }
    expect(extractClaudeSetupOutput(full, 512, false).verificationUrl).toBe(url);
  });
  it('keeps numeric provider failure status without retaining terminal secrets', async () => {
    const h = harness();
    await h.ready;
    await vi.waitFor(() => expect(h.writes).toHaveLength(2));
    h.child.stdout.write(
      'OAuth error: Request failed with status code 503 synthetic#expected https://example.com/?code=private\n'
    );
    await vi.waitFor(() =>
      expect(h.states.at(-1)).toMatchObject({
        code: 'exchange_provider_error',
        detail: 'HTTP 503',
        diagnostics: { stateMatched: true },
      })
    );
    expect(JSON.stringify(h.states)).not.toContain('synthetic#expected');
    expect(JSON.stringify(h.states)).not.toContain('private');
  });
  it('does not save late output after a terminal input failure', async () => {
    const h = harness('synthetic#wrong');
    await h.ready;
    await vi.waitFor(() => expect(h.states.at(-1)).toMatchObject({ code: 'code_state_mismatch' }));
    h.child.stdout.write(`Your token: ${token}\n`);
    h.child.emit('exit', 0, null);
    h.child.emit('close');
    expect(h.writeCredential).not.toHaveBeenCalled();
  });
});
