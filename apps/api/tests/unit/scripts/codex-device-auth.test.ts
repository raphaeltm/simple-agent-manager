import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
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
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`);
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
  });
});
