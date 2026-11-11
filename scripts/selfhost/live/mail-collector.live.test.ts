/**
 * Live: the mail collector's Caddy route (deploy/selfhost/caddy/mail-collector/, start.sh) on the
 * pinned Caddy image, started through start.sh exactly as docker-compose.yml starts it, in front
 * of stub upstreams that record what reaches them.
 *
 * Checked: the collector UI refuses requests without the generated password and never forwards
 * them; the right password reaches it; Caddy's process environment holds only the hash; with the
 * collector off the host is not routed to it; with the collector on and no password Caddy refuses
 * to start.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { freePort, REPO_ROOT, waitFor } from './harness';

const DOMAIN = 'sam.test';
const CADDY_DIR = `${REPO_ROOT}/deploy/selfhost/caddy`;
const PASSWORD = randomBytes(32).toString('hex');
const USER = 'collector';

function caddyImage(): string {
  const dockerfile = readFileSync(`${CADDY_DIR}/Dockerfile`, 'utf8');
  const runtime = [...dockerfile.matchAll(/^FROM (\S+)(?: AS \S+)?$/gm)].map((m) => m[1]!).at(-1);
  if (!runtime?.includes('@sha256:')) throw new Error('Caddy runtime image is not digest-pinned');
  return runtime;
}

interface Stack {
  container: string;
  https: number;
  logs: () => string;
}

const collectorHits: string[] = [];
const celldHits: string[] = [];
let collector: Server;
let celld: Server;
let collectorPort = 0;
let celldPort = 0;
const stacks: Stack[] = [];

function dockerArgs(name: string, env: Record<string, string>): string[] {
  return [
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'host',
    '-v',
    `${CADDY_DIR}:/etc/caddy:ro`,
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--entrypoint',
    '/bin/sh',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    caddyImage(),
    '/etc/caddy/start.sh',
  ];
}

async function startCaddy(extra: Record<string, string>): Promise<Stack> {
  const https = await freePort();
  const container = `sam-live-mail-${randomBytes(4).toString('hex')}`;
  execFileSync(
    'docker',
    dockerArgs(container, {
      SAM_DOMAIN: DOMAIN,
      SAM_TLS_MODE: 'internal',
      HTTP_PORT: String(await freePort()),
      HTTPS_PORT: String(https),
      CELLD_PORT: String(celldPort),
      FRPS_BIND_PORT: String(await freePort()),
      REVERSE_TUNNEL_GATEWAY_SECRET: randomBytes(32).toString('hex'),
      ...extra,
    })
  );
  const logs = () => spawnSync('docker', ['logs', container], { encoding: 'utf8' }).stderr ?? '';
  const stack = { container, https, logs };
  stacks.push(stack);
  await waitFor(
    'Caddy to serve TLS',
    async () => {
      try {
        return (await get(stack, `app.${DOMAIN}`)).status === 200;
      } catch {
        return false;
      }
    },
    120_000,
    logs
  );
  return stack;
}

function get(stack: Stack, host: string, auth?: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port: stack.https,
      servername: host,
      rejectUnauthorized: false,
      path: '/api/v1/messages',
      headers: { Host: host, ...(auth ? { Authorization: auth } : {}) },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

const ON = {
  SAM_MAIL_COLLECTOR: 'on',
  MAIL_COLLECTOR_HOST_LABEL: 'mail',
  MAIL_COLLECTOR_UI_USER: USER,
  MAIL_COLLECTOR_UI_PASSWORD: PASSWORD,
};

beforeAll(async () => {
  collectorPort = await freePort();
  celldPort = await freePort();
  collector = createServer((req, res) => {
    collectorHits.push(req.url ?? '');
    res.end('collector');
  });
  celld = createServer((req, res) => {
    celldHits.push(`${req.headers.host ?? ''}${req.url ?? ''}`);
    res.end('celld');
  });
  await new Promise<void>((done) => collector.listen(collectorPort, '127.0.0.1', done));
  await new Promise<void>((done) => celld.listen(celldPort, '127.0.0.1', done));
});

afterAll(async () => {
  for (const stack of stacks) spawnSync('docker', ['rm', '-f', stack.container]);
  await new Promise<void>((done) => collector.close(() => done()));
  await new Promise<void>((done) => celld.close(() => done()));
});

describe('mail collector route, collector on', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startCaddy({ ...ON, MAIL_COLLECTOR_UI_PORT: String(collectorPort) });
  });

  it('refuses requests without the password and never forwards them', async () => {
    collectorHits.length = 0;
    for (const auth of [undefined, basic(USER, 'wrong'), basic('admin', PASSWORD), 'Bearer x']) {
      expect((await get(stack, `mail.${DOMAIN}`, auth)).status).toBe(401);
    }
    expect(collectorHits).toEqual([]);
  });

  it('control: the generated password reaches the collector UI', async () => {
    collectorHits.length = 0;
    const reply = await get(stack, `mail.${DOMAIN}`, basic(USER, PASSWORD));
    expect(reply).toEqual({ status: 200, body: 'collector' });
    expect(collectorHits).toEqual(['/api/v1/messages']);
  });

  it('keeps the plaintext password out of the running Caddy process', () => {
    const environ = execFileSync('docker', ['exec', stack.container, 'cat', '/proc/1/environ'], {
      encoding: 'utf8',
    });
    expect(environ).not.toContain(PASSWORD);
    expect(environ).toMatch(/MAIL_COLLECTOR_UI_HASH=\$2a\$/);
  });

  it('control: other SAM hosts still go to celld', async () => {
    expect((await get(stack, `app.${DOMAIN}`)).body).toBe('celld');
  });
});

describe('mail collector route, collector off', () => {
  it('does not route the mail host to the collector', async () => {
    const stack = await startCaddy({
      SAM_MAIL_COLLECTOR: 'off',
      MAIL_COLLECTOR_UI_PORT: String(collectorPort),
    });
    collectorHits.length = 0;
    celldHits.length = 0;
    expect((await get(stack, `mail.${DOMAIN}`, basic(USER, PASSWORD))).body).toBe('celld');
    expect(collectorHits).toEqual([]);
    expect(celldHits).toEqual([`mail.${DOMAIN}/api/v1/messages`]);
  });
});

describe('mail collector on without its password', () => {
  it.each([
    ['no password', { ...ON, MAIL_COLLECTOR_UI_PASSWORD: '' }],
    ['a short password', { ...ON, MAIL_COLLECTOR_UI_PASSWORD: 'hunter2' }],
    ['an unknown switch value', { ...ON, SAM_MAIL_COLLECTOR: 'yes' }],
  ])('refuses to start Caddy with %s', async (_, env) => {
    const name = `sam-live-mail-${randomBytes(4).toString('hex')}`;
    stacks.push({ container: name, https: 0, logs: () => '' });
    execFileSync(
      'docker',
      dockerArgs(name, {
        SAM_DOMAIN: DOMAIN,
        SAM_TLS_MODE: 'internal',
        HTTPS_PORT: String(await freePort()),
        HTTP_PORT: String(await freePort()),
        REVERSE_TUNNEL_GATEWAY_SECRET: randomBytes(32).toString('hex'),
        ...env,
      })
    );
    const exit = await waitFor('Caddy to exit', () => {
      const state = spawnSync(
        'docker',
        ['inspect', '-f', '{{.State.Status}} {{.State.ExitCode}}', name],
        {
          encoding: 'utf8',
        }
      ).stdout.trim();
      return state.startsWith('exited') ? state : '';
    });
    expect(exit).toBe('exited 64');
  });
});

/** The mail-collector service exactly as docker-compose.yml defines it, on free ports. */
function collectorService(smtpPort: number, uiPort: number): { image: string; command: string[] } {
  const compose = parse(
    readFileSync(`${REPO_ROOT}/deploy/selfhost/docker-compose.yml`, 'utf8')
  ) as {
    services: Record<string, { image: string; command: string[] }>;
  };
  const service = compose.services['mail-collector']!;
  const command = service.command.map((arg) =>
    arg
      .replace('${MAIL_COLLECTOR_SMTP_PORT:-1025}', String(smtpPort))
      .replace('${MAIL_COLLECTOR_UI_PORT:-8025}', String(uiPort))
  );
  return { image: service.image, command };
}

/** One plaintext SMTP exchange, the way the Worker talks to the collector (SMTP_TLS=none). */
function sendPlainSmtp(port: number, to: string, subject: string): Promise<string[]> {
  const script = [
    'EHLO api.sam.test',
    'MAIL FROM:<sign-in@sam.test>',
    `RCPT TO:<${to}>`,
    'DATA',
    `From: sign-in@sam.test\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\nYour code is 123456\r\n.`,
    'QUIT',
  ];
  return new Promise((done, fail) => {
    const replies: string[] = [];
    const socket = connect(port, '127.0.0.1');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        replies.push(line.slice(0, 3));
        const next = script.shift();
        if (next) socket.write(`${next}\r\n`);
      }
    });
    socket.on('close', () => done(replies));
    socket.on('error', fail);
  });
}

describe('the real collector (Mailpit) as compose runs it', () => {
  const password = randomBytes(32).toString('hex');
  let smtpPort = 0;
  let uiPort = 0;
  const name = `sam-live-mailpit-${randomBytes(4).toString('hex')}`;

  beforeAll(async () => {
    smtpPort = await freePort();
    uiPort = await freePort();
    const { image, command } = collectorService(smtpPort, uiPort);
    stacks.push({ container: name, https: 0, logs: () => '' });
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'host',
      '--user',
      '65534:65534',
      '--read-only',
      '--tmpfs',
      '/tmp',
      '--cap-drop',
      'ALL',
      '-e',
      `MP_UI_AUTH=${USER}:${password}`,
      image,
      ...command,
    ]);
    await waitFor('Mailpit to listen', async () => {
      try {
        return (await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`)).status === 401;
      } catch {
        return false;
      }
    });
  });

  it('accepts plaintext SMTP on loopback and shows the message to the password only', async () => {
    expect(await sendPlainSmtp(smtpPort, 'owner@example.com', 'live code')).toEqual([
      '220',
      '250',
      '250',
      '250',
      '354',
      '250',
      '221',
    ]);
    const unauthenticated = await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`);
    expect(unauthenticated.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`, {
      headers: { Authorization: basic(USER, 'wrong') },
    });
    expect(wrong.status).toBe(401);
    const list = (await (
      await fetch(`http://127.0.0.1:${uiPort}/api/v1/messages`, {
        headers: { Authorization: basic(USER, password) },
      })
    ).json()) as { messages: Array<{ Subject: string; To: Array<{ Address: string }> }> };
    expect(list.messages).toEqual([
      expect.objectContaining({
        Subject: 'live code',
        To: [expect.objectContaining({ Address: 'owner@example.com' })],
      }),
    ]);
  });

  it('refuses the send API without the password too', async () => {
    const res = await fetch(`http://127.0.0.1:${uiPort}/api/v1/send`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
