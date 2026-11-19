/**
 * The SMTP client in real workerd (plan finding F12: the workerd SMTP runtime had only been
 * verified by hand). The unit tests run `smtp-client.ts` through a Node double of
 * `cloudflare:sockets`; here a test Worker (`support/smtp-native-entry.ts`) runs it in Miniflare,
 * against the same fake relay over real TCP. This covers the plaintext loopback path (the box's
 * mail collector) end to end, and that workerd itself refuses a relay certificate it cannot
 * verify, for both STARTTLS and implicit TLS: the client sets no trust of its own.
 *
 * Observed in workerd (2026-11-18): `startTls({ expectedServerHostname })` logs that the option is
 * unsupported and verifies against the hostname given to `connect()`. The client passes the same
 * `config.host` to both, so the check is the one intended; celld honours the option.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestTlsCertificates,
  type FakeSmtpOptions,
  type FakeSmtpServer,
  startFakeSmtpServer,
} from '../helpers/fake-smtp-server';

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve('wrangler/package.json');
const wranglerBin = resolve(dirname(wranglerPackage), require(wranglerPackage).bin.wrangler);
const execute = promisify(execFile);
const { Miniflare } = createRequire(import.meta.resolve('@cloudflare/vitest-pool-workers'))(
  'miniflare'
);

interface Outcome {
  ok: boolean;
  smtpError?: boolean;
  message?: string;
}

let directory = '';
let runtime: {
  dispatchFetch(url: string, init: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};
let relay: FakeSmtpServer | undefined;
const certs = createTestTlsCertificates(['localhost']);

beforeAll(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'sam-smtp-workerd-'));
  const root = resolve(import.meta.dirname, '../..');
  const bundle = resolve(directory, 'bundle');
  const configPath = resolve(directory, 'wrangler.json');
  await writeFile(
    configPath,
    JSON.stringify({
      name: 'sam-smtp-workerd-test',
      main: resolve(root, 'tests/workers/support/smtp-native-entry.ts'),
      compatibility_date: '2026-01-01',
      compatibility_flags: ['nodejs_compat'],
    })
  );
  await execute(
    process.execPath,
    [wranglerBin, 'deploy', '--dry-run', '--config', configPath, '--outdir', bundle],
    { cwd: root, timeout: 60_000, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }
  );
  const files = await readdir(bundle);
  const entry = files.find((name) => name.endsWith('.js'));
  runtime = new Miniflare({
    modulesRoot: bundle,
    modules: [{ type: 'ESModule', path: resolve(bundle, entry ?? 'smtp-native-entry.js') }],
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
  });
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function start(options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  relay = await startFakeSmtpServer({ tls: certs, ...options });
  return relay;
}

async function run(
  op: 'send' | 'probe',
  config: Record<string, unknown>,
  timeoutMs?: number
): Promise<Outcome> {
  const response = await runtime.dispatchFetch('https://smtp-test.example/', {
    method: 'POST',
    body: JSON.stringify({
      op,
      timeoutMs,
      config: { credentials: null, from: 'sign-in@example.com', ...config },
    }),
  });
  return (await response.json()) as Outcome;
}

describe('SMTP client in workerd (cloudflare:sockets)', () => {
  it('delivers one message to a loopback relay in plaintext, dot-stuffed and unstuffed intact', async () => {
    const smtp = await start({ mode: 'plain' });
    expect(await run('send', { host: '127.0.0.1', port: smtp.port, tls: 'none' })).toEqual({
      ok: true,
    });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]?.to).toEqual(['owner@example.com']);
    expect(smtp.messages[0]?.data).toContain('\r\n.a line starting with a dot');
    expect(smtp.commands.at(-1)).toBe('QUIT');
  });

  it('probes a loopback relay without sending', async () => {
    const smtp = await start({ mode: 'plain' });
    expect(await run('probe', { host: '127.0.0.1', port: smtp.port, tls: 'none' })).toEqual({
      ok: true,
    });
    expect(smtp.commands.slice(-2)).toEqual(['RSET', 'QUIT']);
    expect(smtp.messages).toHaveLength(0);
  });

  it('reports a refusal by reply code', async () => {
    const smtp = await start({ mode: 'plain', rcptCode: 550 });
    expect(await run('send', { host: '127.0.0.1', port: smtp.port, tls: 'none' })).toEqual({
      ok: false,
      smtpError: true,
      message: 'SMTP RCPT TO refused with 550',
    });
    expect(smtp.messages).toHaveLength(0);
  });

  it('gives up at the deadline when the relay never answers', async () => {
    const smtp = await start({ mode: 'plain', silent: true });
    const outcome = await run('send', { host: '127.0.0.1', port: smtp.port, tls: 'none' }, 300);
    expect(outcome).toMatchObject({ ok: false, smtpError: true });
    expect(outcome.message).toBe('SMTP exchange timed out after 300 ms');
  });

  it('refuses a STARTTLS relay whose certificate workerd cannot verify, before AUTH', async () => {
    const smtp = await start({
      mode: 'starttls',
      credentials: { username: 'relay-user', password: 'relay-pass' },
    });
    const outcome = await run(
      'send',
      {
        host: 'localhost',
        port: smtp.port,
        tls: 'starttls',
        credentials: { username: 'relay-user', password: 'relay-pass' },
      },
      5_000
    );
    expect(outcome).toMatchObject({ ok: false, smtpError: true });
    // Liveness: the exchange reached STARTTLS, and the credentials never went out.
    expect(smtp.commands).toContain('STARTTLS');
    expect(smtp.commands.some((command) => command.startsWith('AUTH'))).toBe(false);
    expect(smtp.messages).toHaveLength(0);
  });

  it('refuses an implicit-TLS relay whose certificate workerd cannot verify', async () => {
    const smtp = await start({ mode: 'implicit' });
    const outcome = await run('send', { host: 'localhost', port: smtp.port, tls: 'tls' }, 5_000);
    expect(outcome).toMatchObject({ ok: false, smtpError: true });
    expect(smtp.messages).toHaveLength(0);
  });
});
