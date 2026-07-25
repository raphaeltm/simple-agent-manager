import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  getRequestTimeoutMs,
  runDeviceAuth,
  validateDeviceLogin,
} from '../../../scripts/codex-device-auth.mjs';

function fakeAppServer(result: Record<string, unknown>) {
  const process = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = new PassThrough();
  process.kill = vi.fn();
  let writes = 0;
  process.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk)) as { id?: number; method: string };
      writes += 1;
      if (request.method === 'initialize') {
        queueMicrotask(() => {
          process.stdout.write('not-json\n');
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`
          );
        });
      }
      if (request.method === 'account/login/start') {
        queueMicrotask(() => {
          const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
          // Split the response to prove readline waits for a complete JSONL record.
          process.stdout.write(response.slice(0, 17));
          process.stdout.write(`${response.slice(17)}\n`);
        });
      }
      callback();
    },
  });
  return { process, getWrites: () => writes };
}

describe('Codex device-auth driver', () => {
  it('sequences app-server JSONL and publishes only validated actionable state', async () => {
    const fake = fakeAppServer({
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const states: Array<Record<string, unknown>> = [];

    await runDeviceAuth({
      statePath: '/unused',
      spawnProcess: () => fake.process,
      writeState: async (state) => states.push(state),
    });

    expect(fake.getWrites()).toBe(3); // initialize, initialized, login/start
    expect(states).toEqual([
      { status: 'starting' },
      {
        status: 'waiting_for_user',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      },
    ]);
    expect(JSON.stringify(states)).not.toContain('login-1');
  });

  it('rejects and kills the app-server on an untrusted verification URL', async () => {
    const fake = fakeAppServer({
      loginId: 'login-2',
      verificationUrl: 'https://example.com/phish',
      userCode: 'ABCD-EFGH',
    });
    const states: Array<Record<string, unknown>> = [];

    await expect(
      runDeviceAuth({
        statePath: '/unused',
        spawnProcess: () => fake.process,
        writeState: async (state) => states.push(state),
      })
    ).rejects.toThrow(/untrusted verification URL/);

    expect(fake.process.kill).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('rejects malformed codes', () => {
    expect(() =>
      validateDeviceLogin({
        loginId: 'login-3',
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: '<script>',
      })
    ).toThrow(/invalid device code/);
    expect(() =>
      validateDeviceLogin({
        loginId: 'x'.repeat(257),
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
      })
    ).toThrow(/invalid login ID/);
  });

  it('validates the production request-timeout override', () => {
    expect(getRequestTimeoutMs(undefined)).toBe(30_000);
    expect(getRequestTimeoutMs('45000')).toBe(45_000);
    expect(() => getRequestTimeoutMs('0')).toThrow(/positive integer/);
  });

  it('times out and terminates a silent app-server', async () => {
    const fake = fakeAppServer({
      loginId: 'unused',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    fake.process.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    const states: Array<Record<string, unknown>> = [];

    await expect(
      runDeviceAuth({
        statePath: '/unused',
        spawnProcess: () => fake.process,
        requestTimeoutMs: 5,
        writeState: async (state) => states.push(state),
      })
    ).rejects.toThrow(/request timed out/);

    expect(fake.process.kill).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('serializes state writes and never overwrites completion with waiting state', async () => {
    const fake = fakeAppServer({
      loginId: 'login-4',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const states: Array<Record<string, unknown>> = [];
    let releaseWaitingWrite: (() => void) | undefined;

    const run = runDeviceAuth({
      statePath: '/unused',
      spawnProcess: () => fake.process,
      writeState: async (state) => {
        if (state.status === 'waiting_for_user') {
          await new Promise<void>((resolve) => {
            releaseWaitingWrite = resolve;
          });
        }
        states.push(state);
      },
    });

    await vi.waitFor(() => expect(releaseWaitingWrite).toBeTypeOf('function'));
    fake.process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'account/login/completed',
        params: { success: true },
      })}\n`
    );
    releaseWaitingWrite?.();
    await run;
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'completed' }));
  });

  it('publishes failure when app-server exits cleanly before login completion', async () => {
    const fake = fakeAppServer({
      loginId: 'login-5',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    const states: Array<Record<string, unknown>> = [];

    await runDeviceAuth({
      statePath: '/unused',
      spawnProcess: () => fake.process,
      writeState: async (state) => states.push(state),
    });
    fake.process.emit('exit', 0, null);

    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'failed' }));
  });

  it('forwards startup termination immediately and fails the pending request on exit', async () => {
    const fake = fakeAppServer({});
    let initializeWritten = false;
    fake.process.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        initializeWritten = true;
        callback();
      },
    });
    let terminate: (() => void) | undefined;

    const run = runDeviceAuth({
      statePath: '/unused',
      spawnProcess: () => fake.process,
      requestTimeoutMs: 1_000,
      onSpawn: (process) => {
        terminate = () => process.kill('SIGTERM');
      },
      writeState: vi.fn().mockResolvedValue(undefined),
    });

    await vi.waitFor(() => expect(terminate).toBeTypeOf('function'));
    await vi.waitFor(() => expect(initializeWritten).toBe(true));
    terminate?.();
    expect(fake.process.kill).toHaveBeenCalledWith('SIGTERM');
    fake.process.emit('exit', null, 'SIGTERM');
    await expect(run).rejects.toThrow(/exited/);
  });

  it('fails safely when app-server rejects the device-login request', async () => {
    const fake = fakeAppServer({});
    const originalStdin = fake.process.stdin;
    fake.process.stdin = new Writable({
      write(chunk, encoding, callback) {
        const request = JSON.parse(String(chunk)) as { id?: number; method: string };
        if (request.method === 'account/login/start') {
          queueMicrotask(() =>
            fake.process.stdout.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32001, message: 'server overloaded' },
              })}\n`
            )
          );
          callback();
          return;
        }
        originalStdin.write(chunk, encoding, callback);
      },
    });

    await expect(
      runDeviceAuth({
        statePath: '/unused',
        spawnProcess: () => fake.process,
        writeState: vi.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow(/server overloaded/);
    expect(fake.process.kill).toHaveBeenCalledOnce();
  });
});
