/**
 * Self-hosted inbound agent email, end to end: mail enters through the loopback gateway route
 * `POST /api/self-host/gateway/inbound-email` (the route the box's sam-mx receiver calls), runs the
 * real inbound handler and trigger admission into a task, and the agent's `reply_to_email` leaves
 * over SMTP to a real SMTP server with threading headers. No `AGENT_EMAIL` binding, as on a celld
 * box. Real SQLite and KV throughout; only task submission is recorded instead of started.
 *
 * The last block runs the real sam-mx binary (deploy/selfhost/sam-mx, built with `go build`)
 * against the same route through a loopback HTTP bridge, speaking real SMTP to it.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { handleAppError } from '../../src/middleware/app-error-handler';
import { adminAgentEmailRoutes } from '../../src/routes/admin-agent-email';
import { mcpRoutes } from '../../src/routes/mcp';
import { createSelfHostGatewayRoutes } from '../../src/routes/self-host-gateway';
import { __resetAdminSettingsCacheForTest } from '../../src/services/admin-settings';
import { agentEmailConfig } from '../../src/services/agent-email/setup-state';
import { type McpTokenData, storeMcpToken } from '../../src/services/mcp-token';
import { resolvePlatformCapabilities } from '../../src/services/platform-capabilities';
import { __resetPlatformConfigCacheForTest } from '../../src/services/platform-config';
import type { TriggerTaskSubmitter } from '../../src/services/trigger-admission';
import { createAgentEmailTables } from '../helpers/agent-email-tables';
import { type FakeSmtpServer, startFakeSmtpServer } from '../helpers/fake-smtp-server';
import { seedActiveMcpWorkspace } from '../helpers/mcp-route';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../helpers/sqlite-d1';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {} }), {
  virtual: true,
});
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
vi.mock('@cloudflare/containers', () => ({
  Container: class {},
  switchPort: vi.fn((request: Request) => request),
}));

const BASE_DOMAIN = 'box.example';
const ADDRESS_KEY = 'k3j2h7m9q2xw4n8p';
const ADDRESS = `agent+${ADDRESS_KEY}@agents.${BASE_DOMAIN}`;
const TRIGGER_ID = 'trigger-email-1';
const PROJECT_ID = 'project-1';
const SECRET = 'gateway-secret-0123456789abcdef0123456789';
const SMTP_FROM = 'sam@box.example';
const GATEWAY_PATH = '/api/self-host/gateway/inbound-email';

function rawEmail(options: { from?: string; messageId?: string; references?: string } = {}) {
  return [
    `From: ${options.from ?? 'Alice Example <alice@example.com>'}`,
    `To: ${ADDRESS}`,
    'Subject: Please fix the login bug',
    `Message-ID: ${options.messageId ?? '<m1@example.com>'}`,
    ...(options.references ? [`References: ${options.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The login page returns a 500 since this morning. Can you look?',
    '',
  ].join('\r\n');
}

describe('self-hosted inbound agent email', () => {
  let sqlite: Database.Database;
  let smtp: FakeSmtpServer;
  let env: Env;
  let submitter: ReturnType<typeof vi.fn<TriggerTaskSubmitter>>;
  let app: Hono<{ Bindings: Env }>;

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN,
      ENCRYPTION_KEY: 'selfhost-inbound-test-encryption-key-0123',
      REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
      AGENT_EMAIL_INBOUND_SMTP: 'true',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_TLS: 'none',
      SMTP_FROM,
      ...overrides,
    } as Env;
  }

  function gatewayRequest(
    raw: string,
    headers: Record<string, string | null> = {},
    targetEnv: Env = env
  ): Promise<Response> {
    const merged: Record<string, string | null> = {
      'X-SAM-Gateway-Secret': SECRET,
      'X-SAM-Mail-From': 'alice@example.com',
      'X-SAM-Rcpt-To': ADDRESS,
      'X-SAM-Mail-Auth': 'pass',
      'X-SAM-Mail-Auth-From-Domain': 'example.com',
      'Content-Type': 'message/rfc822',
      'Content-Length': String(Buffer.byteLength(raw)),
      ...headers,
    };
    const sent = Object.fromEntries(
      Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null)
    );
    return app.request(GATEWAY_PATH, { method: 'POST', headers: sent, body: raw }, targetEnv);
  }

  function taskCount(): number {
    return (sqlite.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n;
  }

  async function callReplyTool(executionId: string, body: string) {
    const tokenData: McpTokenData = {
      taskId: executionId,
      projectId: PROJECT_ID,
      userId: 'user-1',
      workspaceId: 'workspace-1',
      createdAt: new Date().toISOString(),
    };
    const bearer = `mcp-token-${executionId}`;
    await storeMcpToken(env.KV, bearer, tokenData, env);
    seedActiveMcpWorkspace(sqlite, tokenData);
    const response = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'reply_to_email', arguments: { body } },
        }),
      },
      env
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    const emailTables = new Set(['triggerEmailConfigs', 'triggerEmailMessages']);
    createAllSchemaTables(
      sqlite,
      Object.fromEntries(Object.entries(schema).filter(([name]) => !emailTables.has(name)))
    );
    createAgentEmailTables(sqlite);
    sqlite.exec(
      readFileSync(
        new URL('../../src/db/migrations/0196_admin_settings.sql', import.meta.url),
        'utf8'
      )
    );
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO users (id, email, name, role, status) VALUES ('user-1', 'owner@example.com', 'Owner', 'user', 'active')`
      )
      .run();
    sqlite
      .prepare(`INSERT INTO projects (id, user_id, name) VALUES (?, 'user-1', 'Project')`)
      .run(PROJECT_ID);
    sqlite
      .prepare(
        `INSERT INTO triggers
          (id, project_id, user_id, name, description, status, source_type, skip_if_running,
           prompt_template, agent_profile_id, task_mode, max_concurrent, trigger_count,
           next_execution_sequence, created_at, updated_at)
         VALUES (?, ?, 'user-1', 'Support inbox', NULL, 'active', 'email', 0,
                 'Email from {{email.from}}: {{email.subject}}\n\n{{email.text}}', 'profile-1',
                 'task', 5, 0, 1, ?, ?)`
      )
      .run(TRIGGER_ID, PROJECT_ID, now, now);
    sqlite
      .prepare(
        `INSERT INTO trigger_email_configs (trigger_id, address_key, allowed_senders_json)
         VALUES (?, ?, ?)`
      )
      .run(TRIGGER_ID, ADDRESS_KEY, JSON.stringify(['alice@example.com']));

    smtp = await startFakeSmtpServer({ mode: 'plain' });
    env = makeEnv();
    __resetPlatformConfigCacheForTest();
    __resetAdminSettingsCacheForTest();
    submitter = vi.fn<TriggerTaskSubmitter>(async (_env, input) => {
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO tasks (id, project_id, user_id, title, status, triggered_by,
             trigger_id, trigger_execution_id, created_at, updated_at)
           VALUES (?, ?, ?, 'Email task', 'queued', ?, ?, ?, ?, ?)`
        )
        .run(
          input.triggerExecutionId,
          input.projectId,
          input.userId,
          input.triggeredBy,
          input.triggerId,
          input.triggerExecutionId,
          now,
          now
        );
      return {
        taskId: input.triggerExecutionId,
        sessionId: `chat_${input.triggerExecutionId}`,
        branchName: 'sam/email-task',
      };
    });
    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route(
      '/api/self-host/gateway',
      createSelfHostGatewayRoutes(() => new Response('not used', { status: 500 }), {
        inboundEmailDeps: { submitter },
      })
    );
    app.route('/mcp', mcpRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await smtp.close();
    sqlite.close();
  });

  it('starts a task from an allowed sender and the reply goes out over SMTP, threaded', async () => {
    const response = await gatewayRequest(
      rawEmail({ references: '<root@example.com> <m0@example.com>' })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'accepted' });
    expect(submitter).toHaveBeenCalledTimes(1);
    const submission = submitter.mock.calls[0]![1];
    expect(submission.triggeredBy).toBe('email');
    expect(submission.renderedPrompt).toContain('Email from alice@example.com');
    expect(submission.renderedPrompt).toContain('The login page returns a 500');
    expect(taskCount()).toBe(1);

    const reply = await callReplyTool(submission.triggerExecutionId, 'Fixed and deployed.');
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ result: { content: [{ type: 'text' }] } });
    expect(smtp.messages).toHaveLength(1);
    const sent = smtp.messages[0]!;
    // The relay's own sender on the envelope and in From; answers go back to the trigger.
    expect(sent.from).toBe(SMTP_FROM);
    expect(sent.to).toEqual(['alice@example.com']);
    const head = sent.data.split('\r\n\r\n')[0]!;
    expect(head).toContain(`From: "Support inbox" <${SMTP_FROM}>`);
    expect(head).toContain(`Reply-To: ${ADDRESS}`);
    expect(head).toContain('To: alice@example.com');
    expect(head).toContain('Subject: Re: Please fix the login bug');
    expect(head).toContain('In-Reply-To: <m1@example.com>');
    expect(head).toContain('References: <root@example.com> <m0@example.com> <m1@example.com>');
    expect(head).toContain('Auto-Submitted: auto-replied');
    expect(sent.data).toContain('Fixed and deployed.');
    expect(
      sqlite
        .prepare(
          `SELECT status, to_address AS toAddress FROM trigger_email_messages WHERE direction = 'outbound'`
        )
        .all()
    ).toEqual([{ status: 'sent', toAddress: 'alice@example.com' }]);
  });

  it('refuses a sender outside the allowlist, so the receiver answers 550', async () => {
    const raw = rawEmail({ from: 'Mallory <mallory@example.com>' });
    const response = await gatewayRequest(raw, { 'X-SAM-Mail-From': 'mallory@example.com' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: 'rejected', reason: 'Sender not allowed' });
    expect(submitter).not.toHaveBeenCalled();
    expect(taskCount()).toBe(0);
  });

  it('refuses a From whose domain is not the one the receiver authenticated', async () => {
    // The receiver authenticated attacker.example; the From the Worker parses claims an allowed
    // sender. Must not start anything.
    const response = await gatewayRequest(rawEmail(), {
      'X-SAM-Mail-Auth-From-Domain': 'attacker.example',
    });
    expect(await response.json()).toEqual({
      outcome: 'rejected',
      reason: 'Sender authentication failed',
    });
    expect(submitter).not.toHaveBeenCalled();
    // Control: the same mail with the matching domain is accepted.
    const control = await gatewayRequest(rawEmail({ messageId: '<m2@example.com>' }));
    expect(await control.json()).toEqual({ outcome: 'accepted' });
  });

  it('refuses requests without sender-authentication results', async () => {
    for (const headers of [
      { 'X-SAM-Mail-Auth': null },
      { 'X-SAM-Mail-Auth': 'fail' },
      { 'X-SAM-Mail-Auth-From-Domain': null },
      { 'X-SAM-Mail-Auth-From-Domain': 'not a domain' },
    ]) {
      const response = await gatewayRequest(rawEmail(), headers);
      expect(response.status).toBe(400);
    }
    expect(submitter).not.toHaveBeenCalled();
  });

  it('refuses a request without the gateway secret, and answers 404 without one configured', async () => {
    const missing = await gatewayRequest(rawEmail(), { 'X-SAM-Gateway-Secret': null });
    expect(missing.status).toBe(401);
    const wrong = await gatewayRequest(rawEmail(), { 'X-SAM-Gateway-Secret': `${SECRET}x` });
    expect(wrong.status).toBe(401);
    const unconfigured = await gatewayRequest(
      rawEmail(),
      {},
      makeEnv({ REVERSE_TUNNEL_GATEWAY_SECRET: undefined })
    );
    expect(unconfigured.status).toBe(404);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('answers 404 while the inbound switch is off, and on any Cloudflare install', async () => {
    const off = await gatewayRequest(
      rawEmail(),
      {},
      makeEnv({ AGENT_EMAIL_INBOUND_SMTP: undefined })
    );
    expect(off.status).toBe(404);
    const noSmtp = await gatewayRequest(rawEmail(), {}, makeEnv({ SMTP_HOST: undefined }));
    expect(noSmtp.status).toBe(404);
    const cloudflare = await gatewayRequest(
      rawEmail(),
      {},
      makeEnv({ AGENT_EMAIL: { send: vi.fn() } as unknown as SendEmail })
    );
    expect(cloudflare.status).toBe(404);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('requires an exact Content-Length and refuses a body longer than declared', async () => {
    const raw = rawEmail();
    const longer = await gatewayRequest(raw, { 'Content-Length': String(raw.length - 40) });
    expect(longer.status).toBe(200);
    expect(await longer.json()).toMatchObject({ outcome: 'rejected' });
    expect(submitter).not.toHaveBeenCalled();
  });

  it('requires a Content-Length and refuses one above the gateway cap', async () => {
    const raw = rawEmail();
    const missing = await gatewayRequest(raw, { 'Content-Length': 'abc' });
    expect(missing.status).toBe(411);
    const tooLarge = await gatewayRequest(raw, { 'Content-Length': String(26 * 1024 * 1024) });
    expect(tooLarge.status).toBe(413);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('refuses the Cloudflare-only admin loopback test on a box, and sends nothing', async () => {
    const admin = new Hono<{ Bindings: Env }>();
    admin.onError(handleAppError);
    admin.use('*', async (c, next) => {
      c.set('auth', {
        user: {
          id: 'superadmin-1',
          email: 'superadmin@example.com',
          name: 'Admin',
          avatarUrl: null,
          role: 'superadmin',
          status: 'active',
        },
        session: { id: 'session-1', token: 'token-1', expiresAt: new Date(Date.now() + 3_600_000) },
      });
      c.set('signupApprovalRequired', false);
      await next();
    });
    admin.route('/api/admin/agent-email', adminAgentEmailRoutes);
    const status = await admin.request('/api/admin/agent-email', {}, env);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ enabled: true, domain: `agents.${BASE_DOMAIN}` });
    const loopback = await admin.request(
      '/api/admin/agent-email/loopback',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: ADDRESS }),
      },
      env
    );
    expect(loopback.status).toBe(409);
    expect(smtp.messages).toHaveLength(0);
  });

  it('turns agent email and the inbound capability on only when the receiver is configured', async () => {
    expect(resolvePlatformCapabilities(env).inboundAgentEmail).toBe(true);
    await expect(agentEmailConfig(env)).resolves.toEqual({
      enabled: true,
      domain: `agents.${BASE_DOMAIN}`,
    });
    for (const overrides of [
      { AGENT_EMAIL_INBOUND_SMTP: undefined },
      { AGENT_EMAIL_INBOUND_SMTP: 'false' },
      { REVERSE_TUNNEL_GATEWAY_SECRET: 'too-short' },
      { SMTP_HOST: undefined },
    ] satisfies Partial<Env>[]) {
      const off = makeEnv(overrides);
      expect(resolvePlatformCapabilities(off).inboundAgentEmail).toBe(false);
      await expect(agentEmailConfig(off)).resolves.toEqual({ enabled: false, domain: null });
    }
  });

  describe('through the real sam-mx receiver', () => {
    const goAvailable = (() => {
      try {
        execFileSync('go', ['version'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();
    if (!goAvailable) {
      // Visible in the run output, not silent: the Go tests in deploy/selfhost/sam-mx cover the
      // receiver on its own; this block needs the Go toolchain to build it.
      console.warn('selfhost-inbound-email: go not found, skipping the sam-mx binary tests');
    }
    let binary = '';
    let bridge: http.Server;
    let bridgePort = 0;
    let receiver: ChildProcess | null = null;
    let smtpPort = 0;

    beforeAll(() => {
      if (!goAvailable) return;
      const dir = mkdtempSync(join(tmpdir(), 'sam-mx-'));
      binary = join(dir, 'sam-mx');
      execFileSync('go', ['build', '-o', binary, '.'], {
        cwd: new URL('../../../../deploy/selfhost/sam-mx', import.meta.url).pathname,
        stdio: 'inherit',
      });
    }, 180_000);

    afterAll(() => {
      receiver?.kill();
    });

    async function freePort(): Promise<number> {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as net.AddressInfo;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }

    /** celld's role: HTTP on loopback in front of the Worker's fetch handler. */
    async function startBridge(): Promise<void> {
      bridge = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          void Promise.resolve(
            app.request(
              req.url ?? '/',
              { method: req.method, headers, body: Buffer.concat(chunks) },
              env
            )
          ).then(async (response) => {
            res.writeHead(response.status, { 'Content-Type': 'application/json' });
            res.end(Buffer.from(await response.arrayBuffer()));
          });
        });
      });
      await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
      bridgePort = (bridge.address() as net.AddressInfo).port;
    }

    async function startReceiver(): Promise<void> {
      smtpPort = await freePort();
      receiver = spawn(binary, [], {
        env: {
          PATH: process.env.PATH ?? '',
          SAM_DOMAIN: BASE_DOMAIN,
          REVERSE_TUNNEL_GATEWAY_SECRET: SECRET,
          SAM_MX_LISTEN: `127.0.0.1:${smtpPort}`,
          SAM_MX_GATEWAY_URL: `http://127.0.0.1:${bridgePort}${GATEWAY_PATH}`,
          // The smoke-test path: box loopback is trusted, so no DNS is needed.
          SAM_MX_TRUSTED_NETWORKS: '127.0.0.1/32',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('sam-mx did not start')), 10_000);
        receiver!.stdout!.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('sam-mx: listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        receiver!.on('exit', (code) => reject(new Error(`sam-mx exited with ${code}`)));
      });
    }

    /** A minimal SMTP client: one transaction, returns every reply line. */
    async function smtpSession(mailFrom: string, rcptTo: string, data: string): Promise<string[]> {
      const socket = net.connect(smtpPort, '127.0.0.1');
      const replies: string[] = [];
      let buffer = '';
      let waiting: ((line: string) => void) | null = null;
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          // Multi-line replies: only the last line (code + space) completes the reply.
          if (/^\d{3} /.test(line)) {
            replies.push(line);
            const resolve = waiting;
            waiting = null;
            resolve?.(line);
          }
        }
      });
      const next = () => new Promise<string>((resolve) => (waiting = resolve));
      const command = (line: string) => {
        const reply = next();
        socket.write(`${line}\r\n`);
        return reply;
      };
      await next(); // greeting
      await command('EHLO client.example.com');
      await command(`MAIL FROM:<${mailFrom}>`);
      const rcpt = await command(`RCPT TO:<${rcptTo}>`);
      if (rcpt.startsWith('250')) {
        const dataReply = await command('DATA');
        if (dataReply.startsWith('354')) {
          await command(`${data.replace(/(^|\r\n)\./g, '$1..')}\r\n.`);
        }
      }
      await command('QUIT');
      socket.destroy();
      return replies;
    }

    it.skipIf(!goAvailable)(
      'an SMTP message from an allowed sender starts a task, and the reply goes out',
      async () => {
        await startBridge();
        await startReceiver();
        try {
          const accepted = await smtpSession('alice@example.com', ADDRESS, rawEmail());
          expect(accepted.at(-2)).toMatch(/^250 /);
          expect(taskCount()).toBe(1);
          const executionId = submitter.mock.calls[0]![1].triggerExecutionId;

          const refused = await smtpSession(
            'mallory@example.com',
            ADDRESS,
            rawEmail({ from: 'mallory@example.com', messageId: '<m9@example.com>' })
          );
          expect(refused.at(-2)).toMatch(/^550 5\.7\.1 Sender not allowed/);
          const unknown = await smtpSession(
            'alice@example.com',
            `agent+aaaaaaaaaaaaaaaa@agents.${BASE_DOMAIN}`,
            rawEmail({ messageId: '<m10@example.com>' })
          );
          expect(unknown.at(-2)).toMatch(/^550 /);
          expect(taskCount()).toBe(1);

          const reply = await callReplyTool(executionId, 'On it.');
          expect(reply.status).toBe(200);
          expect(smtp.messages).toHaveLength(1);
          expect(smtp.messages[0]!.data).toContain('In-Reply-To: <m1@example.com>');
          expect(smtp.messages[0]!.data).toContain(`Reply-To: ${ADDRESS}`);
        } finally {
          receiver?.kill();
          receiver = null;
          await new Promise<void>((resolve) => bridge.close(() => resolve()));
        }
      },
      60_000
    );
  });
});
