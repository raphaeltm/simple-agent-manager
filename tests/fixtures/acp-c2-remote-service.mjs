/**
 * Disposable HTTPS MCP service for the ACP C2 staging gate.
 *
 * Run with ACP_C2_FIXTURE_PUBLIC_URL=https://<dedicated-host>,
 * ACP_C2_FIXTURE_TLS_KEY_PATH, ACP_C2_FIXTURE_TLS_CERT_PATH, and
 * ACP_C2_FIXTURE_MCP_TOKEN set to ephemeral test values. The host's certificate
 * must be publicly trusted for a real staging browser/wrapper. No redirect,
 * callback proxy, URL fetch, or credential exchange is implemented here.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SESSIONS = 8;
const MAX_PENDING = 16;
const MAX_EVENTS = 128;
const MAX_AGE_MS = 20 * 60 * 1000;
const HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...HEADERS, 'Content-Type': contentType });
  res.end(body);
}

function tokenMatches(value, expected) {
  const given = Buffer.from(value ?? '');
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function fixtureAuthorized(req, expected) {
  return tokenMatches(req.headers.authorization, expected) ||
    tokenMatches(req.headers['x-acp-c2-fixture-auth'], expected);
}

async function readBody(req, limit) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

export function createFixtureServer({
  publicUrl,
  tlsKey,
  tlsCert,
  mcpToken,
  samPortProxy = false,
  formTool = false,
  maxEvents = MAX_EVENTS,
  now = () => Date.now(),
  log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
}) {
  if (!publicUrl || new URL(publicUrl).protocol !== 'https:' || !mcpToken ||
      (!samPortProxy && (!tlsKey || !tlsCert))) {
    throw new Error('public HTTPS URL, TLS certificate/key, and MCP token are required');
  }
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_EVENTS)
    throw new Error('event retention must be within fixture bounds');
  const base = new URL(publicUrl);
  if (base.pathname !== '/' || base.search || base.hash)
    throw new Error('public URL must be an origin');
  const sessions = new Map();
  const pending = new Map();
  const events = [];
  const record = (kind, id, diagnostics = {}) => {
    const entry = { kind, elicitationId: id, at: now(), ...diagnostics };
    events.push(entry);
    if (events.length > maxEvents) events.shift();
    log(entry);
  };
  const prune = () => {
    for (const [state, item] of pending)
      if (now() - item.createdAt > MAX_AGE_MS) pending.delete(state);
  };

  function buildMcpServer() {
    const server = new McpServer({ name: 'sam-acp-c2-fixture', version: '1.0.0' });
    const recordError = (id, mode, error) => {
      const capabilities = server.server.getClientCapabilities()?.elicitation;
      // Never copy exception messages/data: they may contain service URLs,
      // credentials or user input. Capability booleans and numeric codes suffice.
      record('request_error', id, {
        mode,
        formSupported: capabilities?.form != null,
        urlSupported: capabilities?.url != null,
        errorCode: Number.isSafeInteger(error?.code) ? error.code : null,
      });
    };
    server.registerTool(
      'request_remote_url',
      {
        description: 'Ask the session creator to approve a controlled remote HTTPS URL fixture.',
      },
      async () => {
        prune();
        if (pending.size >= MAX_PENDING)
          return { isError: true, content: [{ type: 'text', text: 'fixture capacity reached' }] };
        const elicitationId = randomUUID();
        const state = randomBytes(24).toString('hex');
        const item = { elicitationId, createdAt: now(), completed: false, notify: null,
          notifyId: (id) => server.server.createElicitationCompletionNotifier(id)() };
        pending.set(state, item);
        const approvalUrl = new URL('/approve', base);
        approvalUrl.searchParams.set('state', state);
        record('requested', elicitationId);
        let result;
        try {
          item.notify = server.server.createElicitationCompletionNotifier(elicitationId);
          result = await server.server.elicitInput({
            mode: 'url',
            elicitationId,
            url: approvalUrl.toString(),
            message:
              'Approve this controlled remote HTTPS service fixture. Completion is reported separately.',
          });
        } catch (error) {
          recordError(elicitationId, 'url', error);
          return { isError: true, content: [{ type: 'text', text: 'elicitation cancelled' }] };
        }
        record(
          result.action === 'accept'
            ? 'accepted'
            : result.action === 'decline'
              ? 'declined'
              : 'cancelled',
          elicitationId
        );
        return { content: [{ type: 'text', text: `Fixture elicitation ${result.action}.` }] };
      }
    );
    if (formTool) {
      server.registerTool(
        'request_form',
        { description: 'Ask for a controlled local form response.' },
        async () => {
          const elicitationId = randomUUID();
          record('requested', elicitationId);
          let result;
          try {
            result = await server.server.elicitInput({
              mode: 'form',
              message: 'Enter a test response.',
              requestedSchema: {
                type: 'object',
                properties: { response: { type: 'string' } },
                required: ['response'],
              },
            });
          } catch (error) {
            recordError(elicitationId, 'form', error);
            return { isError: true, content: [{ type: 'text', text: 'elicitation cancelled' }] };
          }
          record(
            result.action === 'accept' ? 'accepted' : result.action === 'decline' ? 'declined' : 'cancelled',
            elicitationId
          );
          return { content: [{ type: 'text', text: `Fixture form ${result.action}.` }] };
        }
      );
    }
    return server;
  }

  const handle = async (req, res) => {
    const target = new URL(req.url ?? '/', base);
    try {
      if (target.pathname === '/approve' && req.method === 'GET') {
        prune();
        const state = target.searchParams.get('state');
        const item = state && pending.get(state);
        if (!item) return send(res, 404, 'Fixture request unavailable');
        const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>ACP C2 fixture</title><main style="font:16px sans-serif;max-width:38rem;margin:4rem auto;padding:1rem"><h1>Remote service fixture</h1><p>This test service reports completion only after you press the button. Opening this page does not complete it.</p><form method="post" action="/complete"><input type="hidden" name="state" value="${state}"><button type="submit">Complete test service</button></form></main>`;
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (target.pathname === '/complete' && req.method === 'POST') {
        prune();
        const form = new URLSearchParams(await readBody(req, 1024));
        const state = form.get('state');
        const item = state && pending.get(state);
        if (!item) return send(res, 404, 'Fixture request unavailable');
        if (!item.completed) {
          item.completed = true;
          record('service_completed', item.elicitationId);
          await item.notify();
          record('completion_notified', item.elicitationId);
        }
        return send(
          res,
          200,
          '<!doctype html><title>Completed</title><h1>Test service completed</h1>',
          'text/html; charset=utf-8'
        );
      }
      if (target.pathname === '/admin/replay' && req.method === 'POST') {
        if (!fixtureAuthorized(req, mcpToken))
          return send(res, 401, 'Unauthorized');
        prune();
        const form = new URLSearchParams(await readBody(req, 1024));
        const item = pending.get(form.get('state'));
        if (!item || !item.completed) return send(res, 409, 'No completed fixture request');
        await item.notify();
        record('completion_replayed', item.elicitationId);
        return send(res, 204, '');
      }
      if (target.pathname === '/admin/notify-id' && req.method === 'POST') {
        if (!fixtureAuthorized(req, mcpToken))
          return send(res, 401, 'Unauthorized');
        prune();
        const form = new URLSearchParams(await readBody(req, 1024));
        const item = pending.get(form.get('state'));
        const id = form.get('elicitationId');
        if (!item || !id || id.length > 256) return send(res, 400, 'Invalid fixture request');
        await item.notifyId(id);
        record('test_notification', id);
        return send(res, 204, '');
      }
      if (target.pathname === '/mcp') {
        if (!fixtureAuthorized(req, mcpToken))
          return send(res, 401, 'Unauthorized');
        const sessionId = req.headers['mcp-session-id'];
        let entry = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
        if (!entry && req.method === 'POST' && !sessionId) {
          const body = JSON.parse(await readBody(req, MAX_BODY_BYTES));
          if (body.method !== 'initialize' || sessions.size >= MAX_SESSIONS)
            return send(res, 400, 'Invalid initialization');
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => sessions.set(id, { transport, server }),
          });
          const server = buildMcpServer();
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await server.connect(transport);
          return await transport.handleRequest(req, res, body);
        }
        if (!entry) return send(res, 404, 'MCP session not found');
        return await entry.transport.handleRequest(req, res);
      }
      return send(res, 404, 'Not found');
    } catch {
      if (!res.headersSent) send(res, 400, 'Invalid fixture request');
      else res.destroy();
    }
  };
  const listener = samPortProxy ? createHttpServer(handle) : createHttpsServer({ key: tlsKey, cert: tlsCert }, handle);
  return {
    listener,
    events,
    close: () => Promise.all([...sessions.values()].map((entry) => entry.server.close())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = createFixtureServer({
    publicUrl: process.env.ACP_C2_FIXTURE_PUBLIC_URL,
    tlsKey: process.env.ACP_C2_FIXTURE_SAM_PORT_PROXY === 'true' ? undefined : readFileSync(process.env.ACP_C2_FIXTURE_TLS_KEY_PATH),
    tlsCert: process.env.ACP_C2_FIXTURE_SAM_PORT_PROXY === 'true' ? undefined : readFileSync(process.env.ACP_C2_FIXTURE_TLS_CERT_PATH),
    mcpToken: process.env.ACP_C2_FIXTURE_MCP_TOKEN,
    samPortProxy: process.env.ACP_C2_FIXTURE_SAM_PORT_PROXY === 'true',
  });
  const port = Number.parseInt(process.env.ACP_C2_FIXTURE_PORT ?? '8443', 10);
  fixture.listener.listen(port, process.env.ACP_C2_FIXTURE_BIND_HOST ?? '127.0.0.1');
}
