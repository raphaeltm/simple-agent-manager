#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Codex app-server protocol fields are intentionally bounded before crossing the
// runtime boundary. These are defensive protocol invariants, not operator limits.
const MAX_DEVICE_CODE_LENGTH = 128;
const MAX_LOGIN_ID_LENGTH = 256;

export function getRequestTimeoutMs(value = process.env.CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS) {
  if (value === undefined || value === '') return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('CODEX_DEVICE_AUTH_REQUEST_TIMEOUT_MS must be a positive integer');
  }
  return parsed;
}

export function validateDeviceLogin(result) {
  if (
    typeof result?.verificationUrl !== 'string' ||
    typeof result?.userCode !== 'string' ||
    typeof result?.loginId !== 'string'
  ) {
    throw new Error('Codex app-server returned an incomplete device-login response');
  }
  const verificationUrl = new URL(result.verificationUrl);
  if (
    verificationUrl.protocol !== 'https:' ||
    (verificationUrl.hostname !== 'openai.com' && !verificationUrl.hostname.endsWith('.openai.com'))
  ) {
    throw new Error('Codex app-server returned an untrusted verification URL');
  }
  if (
    result.userCode.length > MAX_DEVICE_CODE_LENGTH ||
    !/^[A-Za-z0-9-]{4,}$/.test(result.userCode)
  ) {
    throw new Error('Codex app-server returned an invalid device code');
  }
  if (
    result.loginId.length === 0 ||
    result.loginId.length > MAX_LOGIN_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/.test(result.loginId)
  ) {
    throw new Error('Codex app-server returned an invalid login ID');
  }
  return {
    verificationUrl: verificationUrl.toString(),
    userCode: result.userCode,
  };
}

export async function runDeviceAuth({
  statePath,
  spawnProcess = spawn,
  requestTimeoutMs = getRequestTimeoutMs(),
  onSpawn,
  writeState = async (state) => {
    const temporaryStatePath = `${statePath}.tmp`;
    await writeFile(temporaryStatePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(temporaryStatePath, statePath);
  },
}) {
  const appServer = spawnProcess('codex', ['app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  onSpawn?.(appServer);
  let nextId = 1;
  let loginCompleted = false;
  let terminalStatePublished = false;
  let stateWriteQueue = Promise.resolve();
  const pending = new Map();

  function publishState(state) {
    const isTerminal = state.status === 'completed' || state.status === 'failed';
    if (terminalStatePublished) return stateWriteQueue;
    if (isTerminal) terminalStatePublished = true;
    stateWriteQueue = stateWriteQueue.then(() => writeState(state));
    return stateWriteQueue;
  }

  function publishStateFromEvent(state) {
    void publishState(state).catch(() => {
      appServer.kill();
    });
  }

  function request(method, params) {
    const id = nextId++;
    appServer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  function notify(method, params) {
    appServer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  createInterface({ input: appServer.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error)
        waiter.reject(new Error(message.error.message ?? 'Codex app-server error'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'account/login/completed') {
      loginCompleted = true;
      publishStateFromEvent({
        status: message.params?.success === false ? 'failed' : 'completed',
        error: message.params?.error ?? null,
      });
    }
  });

  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  appServer.on('error', (error) => {
    rejectPending(error);
    publishStateFromEvent({ status: 'failed', error: error.message });
  });
  appServer.on('exit', (code, signal) => {
    if (!loginCompleted) {
      const error = new Error(`Codex app-server exited (${code ?? signal})`);
      rejectPending(error);
      publishStateFromEvent({ status: 'failed', error: error.message });
    }
  });

  try {
    await publishState({ status: 'starting' });
    await request('initialize', {
      clientInfo: { name: 'sam-credential-setup', title: 'SAM credential setup', version: '1.0.0' },
    });
    notify('initialized');
    const result = await request('account/login/start', { type: 'chatgptDeviceCode' });
    await publishState({ status: 'waiting_for_user', ...validateDeviceLogin(result) });
    return appServer;
  } catch (error) {
    await publishState({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    appServer.kill();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const statePath = process.argv[2];
  if (!statePath) {
    process.stderr.write('Usage: codex-device-auth.mjs <state-path>\n');
    process.exitCode = 2;
  } else {
    runDeviceAuth({
      statePath,
      onSpawn: (appServer) => {
        process.once('SIGTERM', () => appServer.kill('SIGTERM'));
      },
    }).catch(() => {
      process.exitCode = 1;
    });
  }
}
