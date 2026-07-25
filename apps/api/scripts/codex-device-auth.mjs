#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

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
    (verificationUrl.hostname !== 'openai.com' &&
      !verificationUrl.hostname.endsWith('.openai.com'))
  ) {
    throw new Error('Codex app-server returned an untrusted verification URL');
  }
  if (!/^[A-Za-z0-9-]{4,128}$/.test(result.userCode)) {
    throw new Error('Codex app-server returned an invalid device code');
  }
  return {
    verificationUrl: verificationUrl.toString(),
    userCode: result.userCode,
  };
}

export async function runDeviceAuth({
  statePath,
  spawnProcess = spawn,
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
  let nextId = 1;
  const pending = new Map();

  function request(method, params) {
    const id = nextId++;
    appServer.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
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
      if (message.error) waiter.reject(new Error(message.error.message ?? 'Codex app-server error'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === 'account/login/completed') {
      void writeState({
        status: message.params?.success === false ? 'failed' : 'completed',
        error: message.params?.error ?? null,
      });
    }
  });

  appServer.on('error', (error) => {
    void writeState({ status: 'failed', error: error.message });
  });
  appServer.on('exit', (code, signal) => {
    if (code !== 0) {
      void writeState({ status: 'failed', error: `Codex app-server exited (${code ?? signal})` });
    }
  });

  try {
    await writeState({ status: 'starting' });
    await request('initialize', {
      clientInfo: { name: 'sam-credential-setup', title: 'SAM credential setup', version: '1.0.0' },
    });
    notify('initialized');
    const result = await request('account/login/start', { type: 'chatgptDeviceCode' });
    await writeState({ status: 'waiting_for_user', ...validateDeviceLogin(result) });
  } catch (error) {
    await writeState({
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
    runDeviceAuth({ statePath }).catch(() => {
      process.exitCode = 1;
    });
  }
}
