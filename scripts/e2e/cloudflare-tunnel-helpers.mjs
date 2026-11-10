/** Opt-in staging helpers. No provisioning, deployment, or credential logging.
 * Protocol: packages/terminal/src/protocol.ts and vm-agent/internal/server/server.go.
 * Callers own fixtures and cleanup. VM and instant use the same workspace interfaces.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { chromium } = requireWeb('@playwright/test');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/** Explicit staging domain is required; arbitrary URLs and literal IP targets are rejected. */
export function stagingTargetGuard(stagingBaseDomain) {
  assert(
    typeof stagingBaseDomain === 'string' && /^[a-z0-9.-]+$/.test(stagingBaseDomain),
    'A staging DNS domain is required'
  );
  const base = new URL(`https://${stagingBaseDomain}`).hostname;
  assert(base === stagingBaseDomain && !isIP(base) && base.includes('.'), 'Invalid staging domain');
  return (value, { websocket = false } = {}) => {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    assert(!isIP(hostname), 'Literal IP targets are forbidden');
    assert(url.protocol === (websocket ? 'wss:' : 'https:'), 'Secure staging transport required');
    assert(
      !url.username && !url.password && !url.port,
      'URL credentials and custom ports are forbidden'
    );
    assert(
      hostname === base || hostname.endsWith(`.${base}`),
      'Target is outside configured staging domain'
    );
    return url;
  };
}

/** Returns only allowlisted metadata; bodies, URLs, headers and tokens never enter evidence. */
export function safeEvidence({
  kind,
  status,
  bytes,
  sha256,
  durationMs,
  firstByteMs,
  frames,
  exitCode,
  passed,
}) {
  assert(typeof kind === 'string' && /^[a-z0-9_-]{1,60}$/i.test(kind), 'Invalid evidence kind');
  const result = { kind };
  for (const [name, value] of Object.entries({
    status,
    bytes,
    durationMs,
    firstByteMs,
    frames,
    exitCode,
  })) {
    if (value !== undefined) {
      assert(Number.isFinite(value), `Invalid evidence metric: ${name}`);
      result[name] = value;
    }
  }
  if (sha256 !== undefined) {
    assert(/^[a-f0-9]{64}$/.test(sha256), 'Invalid digest');
    result.sha256 = sha256;
  }
  if (passed !== undefined) result.passed = Boolean(passed);
  return result;
}

/** Cookie is a raw Cookie header from the staging login; kept only in memory.
 * api() returns JSON (may include tokens: never serialize it as evidence).
 * request() returns APIResponse for byte/status assertions; redirects stay explicit.
 */
export async function createSessionClient({
  stagingBaseDomain,
  cookie,
  timeoutMs = 30_000,
  launchOptions = {},
}) {
  assert(typeof cookie === 'string' && !/[\r\n]/.test(cookie), 'Session cookie required');
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Invalid timeout');
  const guard = stagingTargetGuard(stagingBaseDomain);
  const apiOrigin = `https://api.${stagingBaseDomain}`;
  const appOrigin = `https://app.${stagingBaseDomain}`;
  const browser = await chromium.launch({ headless: true, ...launchOptions });
  let context;
  try {
    context = await browser.newContext();
    const cookies = (cookie ? cookie.split(';') : []).map((part) => {
      const index = part.indexOf('=');
      assert(index > 0, 'Malformed session cookie');
      return {
        name: part.slice(0, index).trim(),
        value: part.slice(index + 1).trim(),
        ...(part.slice(0, index).trim().startsWith('__Host-')
          ? { url: apiOrigin }
          : { domain: `.${stagingBaseDomain}`, path: '/' }),
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      };
    });
    if (cookie) await context.addCookies(cookies);
  } catch {
    await browser.close();
    throw new Error('Unable to initialize staging browser session');
  }
  async function request(target, options = {}) {
    const url = guard(new URL(target, apiOrigin).href);
    try {
      return await context.request.fetch(url.href, {
        ...options,
        headers: { Origin: appOrigin, ...options.headers },
        timeout: timeoutMs,
        maxRedirects: 0,
      });
    } catch {
      throw new Error('Staging HTTP request failed or timed out');
    }
  }
  async function api(path, { method = 'GET', json, expectedStatus, ...options } = {}) {
    assert(path.startsWith('/api/') && !path.startsWith('//'), 'API path required');
    const response = await request(`${apiOrigin}${path}`, {
      ...options,
      method,
      ...(json === undefined ? {} : { data: json }),
    });
    assert(
      expectedStatus === undefined ? response.ok() : response.status() === expectedStatus,
      `Staging API returned HTTP ${response.status()}`
    );
    try {
      return await response.json();
    } catch {
      throw new Error('Staging API did not return JSON');
    }
  }
  // Giving the page a real staging origin avoids null-Origin WebSocket/CORS behavior.
  async function pageAt(origin = appOrigin) {
    guard(origin);
    const page = await context.newPage();
    const synthetic = `${new URL(origin).origin}/__sam_e2e_${randomUUID()}`;
    await page.route(synthetic, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Staging transport test</title>',
      })
    );
    await page.goto(synthetic);
    return page;
  }
  return {
    guard,
    apiOrigin,
    appOrigin,
    timeoutMs,
    request,
    api,
    pageAt,
    close: () => browser.close(),
  };
}

async function socketPage(client, url, origin) {
  client.guard(url, { websocket: true });
  const page = await client.pageAt(origin);
  try {
    await page.evaluate(
      ({ url, timeout }) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(url);
          ws.binaryType = 'arraybuffer';
          const state = (window.__samE2e = { ws, messages: [], closed: false, failed: false });
          ws.onmessage = (event) =>
            state.messages.push(
              typeof event.data === 'string'
                ? { text: event.data }
                : { binary: Array.from(new Uint8Array(event.data)) }
            );
          ws.onclose = () => {
            state.closed = true;
          };
          ws.onerror = () => {
            state.failed = true;
            reject(new Error('WebSocket failed'));
          };
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket timeout'));
          }, timeout);
          ws.onopen = () => {
            clearTimeout(timer);
            resolve();
          };
        }),
      { url, timeout: client.timeoutMs }
    );
  } catch {
    await page.close();
    throw new Error('Staging WebSocket connection failed');
  }
  return page;
}

async function waitSocket(page, predicate, argument, timeout) {
  try {
    await page.waitForFunction(predicate, argument, { timeout });
  } catch {
    throw new Error('Expected WebSocket evidence did not arrive');
  }
  const failed = await page.evaluate(() => window.__samE2e.failed);
  assert(!failed, 'WebSocket transport failed');
}

/** Workspace token remains in memory. Methods return no credentials.
 * run() returns {output,exitCode,evidence}; output is PRIVATE and may contain secrets.
 * One run at a time per terminal. Reconnect by opening a new client then reattach(id).
 */
export async function openTerminal(client, { workspaceUrl, token }) {
  const url = client.guard(workspaceUrl);
  url.protocol = 'wss:';
  url.pathname = '/terminal/ws/multi';
  url.search = new URLSearchParams({ token }).toString();
  const page = await socketPage(client, url.href, client.appOrigin);
  let running = false;
  const send = (message) =>
    page.evaluate((message) => window.__samE2e.ws.send(JSON.stringify(message)), message);
  async function operation(type, sessionId, data, expectedType) {
    const start = await page.evaluate(() => window.__samE2e.messages.length);
    await send({ type, data: { sessionId, ...data } });
    await waitSocket(
      page,
      ({ start, sessionId, expectedType }) =>
        window.__samE2e.messages.slice(start).some((frame) => {
          if (!frame.text) return false;
          try {
            const msg = JSON.parse(frame.text);
            return (
              msg.type === expectedType && (msg.sessionId || msg.data?.sessionId) === sessionId
            );
          } catch {
            return false;
          }
        }),
      { start, sessionId, expectedType },
      client.timeoutMs
    );
    return sessionId;
  }
  return {
    create: ({ sessionId = randomUUID(), rows = 24, cols = 80, workDir, name } = {}) =>
      operation(
        'create_session',
        sessionId,
        { rows, cols, ...(workDir ? { workDir } : {}), ...(name ? { name } : {}) },
        'session_created'
      ),
    reattach: (sessionId, { rows = 24, cols = 80 } = {}) =>
      operation('reattach_session', sessionId, { rows, cols }, 'session_reattached'),
    input: (sessionId, data) => send({ type: 'input', sessionId, data: { data } }),
    resize: (sessionId, rows, cols) => send({ type: 'resize', sessionId, data: { rows, cols } }),
    closeSession: (sessionId) => operation('close_session', sessionId, {}, 'session_closed'),
    disconnect: () => page.close(),
    async run(sessionId, command, { timeoutMs = client.timeoutMs } = {}) {
      assert(!running, 'Concurrent terminal commands are unsupported');
      assert(
        typeof command === 'string' && command.length > 0 && !command.includes('\0'),
        'Shell command required'
      );
      running = true;
      const marker = `SAM_E2E_${randomUUID().replaceAll('-', '')}`;
      const started = performance.now();
      try {
        const start = await page.evaluate(() => window.__samE2e.messages.length);
        // Splitting marker in the source prevents terminal echo from matching completion.
        const split = Math.floor(marker.length / 2);
        await send({
          type: 'input',
          sessionId,
          data: {
            data: `bash -c ${quote(command)}; sam_e2e_rc=$?; printf '\\n%s%s:%s\\n' '${marker.slice(0, split)}' '${marker.slice(split)}' "$sam_e2e_rc"\r`,
          },
        });
        await waitSocket(
          page,
          ({ start, sessionId, marker }) => {
            const text = window.__samE2e.messages
              .slice(start)
              .map((frame) => {
                try {
                  const m = JSON.parse(frame.text);
                  return (m.type === 'output' || m.type === 'scrollback') &&
                    m.sessionId === sessionId
                    ? m.data?.data || ''
                    : '';
                } catch {
                  return '';
                }
              })
              .join('');
            return new RegExp(`${marker}:[0-9]+\\r?\\n`).test(text);
          },
          { start, sessionId, marker },
          timeoutMs
        );
        const text = await page.evaluate(
          ({ start, sessionId }) =>
            window.__samE2e.messages
              .slice(start)
              .map((frame) => {
                try {
                  const m = JSON.parse(frame.text);
                  return (m.type === 'output' || m.type === 'scrollback') &&
                    m.sessionId === sessionId
                    ? m.data?.data || ''
                    : '';
                } catch {
                  return '';
                }
              })
              .join(''),
          { start, sessionId }
        );
        const match = text.match(new RegExp(`${marker}:([0-9]+)\\r?\\n`));
        assert(match, 'Terminal completion marker missing');
        const exitCode = Number(match[1]);
        return {
          output: text.slice(0, match.index),
          exitCode,
          evidence: safeEvidence({
            kind: 'terminal_command',
            exitCode,
            durationMs: performance.now() - started,
            passed: exitCode === 0,
          }),
        };
      } finally {
        running = false;
      }
    },
  };
}

/** Redirects are not followed; test their Location separately through client.guard(). */
export async function assertPreviewHttp(
  client,
  url,
  { status = 200, expectedBody, expectedSha256, ...request } = {}
) {
  const started = performance.now();
  const response = await client.request(url, request);
  assert(
    response.status() === status,
    `Preview HTTP ${response.status()} did not match expected status`
  );
  const body = await response.body();
  if (expectedBody !== undefined)
    assert(body.equals(Buffer.from(expectedBody)), 'Preview response bytes differ');
  const sha256 = digest(body);
  if (expectedSha256 !== undefined) assert(sha256 === expectedSha256, 'Preview digest differs');
  return safeEvidence({
    kind: 'preview_http',
    status,
    bytes: body.length,
    sha256,
    durationMs: performance.now() - started,
    passed: true,
  });
}

/** Fixture must emit delayed chunks. Requires first data before complete body by minGapMs. */
export async function assertPreviewStreaming(client, url, { minGapMs = 200, expectedText } = {}) {
  const target = client.guard(url);
  const page = await client.pageAt(target.origin);
  try {
    const result = await page
      .evaluate(
        async ({ url, timeout }) => {
          const started = performance.now();
          const response = await fetch(url, {
            credentials: 'include',
            redirect: 'error',
            signal: AbortSignal.timeout(timeout),
          });
          if (!response.ok || !response.body) throw new Error('Streaming response unavailable');
          const reader = response.body.getReader();
          const chunks = [];
          let firstByteMs;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.length && firstByteMs === undefined)
              firstByteMs = performance.now() - started;
            chunks.push(...value);
          }
          return {
            bytes: chunks,
            firstByteMs,
            durationMs: performance.now() - started,
            status: response.status,
          };
        },
        { url: target.href, timeout: client.timeoutMs }
      )
      .catch(() => {
        throw new Error('Preview streaming failed');
      });
    assert(
      result.firstByteMs !== undefined && result.durationMs - result.firstByteMs >= minGapMs,
      'Response was buffered or fixture delay was insufficient'
    );
    const body = Buffer.from(result.bytes);
    if (expectedText !== undefined)
      assert(body.toString() === expectedText, 'Streaming content differs');
    return safeEvidence({
      kind: 'preview_stream',
      status: result.status,
      bytes: body.length,
      sha256: digest(body),
      firstByteMs: result.firstByteMs,
      durationMs: result.durationMs,
      passed: true,
    });
  } finally {
    await page.close();
  }
}

/** Fixture echoes each frame unchanged; validates both text and binary frames. */
export async function assertPreviewWebSocket(
  client,
  url,
  { text = 'sam-e2e-text', binary = [0, 1, 127, 128, 255], idleMs = 0 } = {}
) {
  const target = client.guard(url, { websocket: true });
  const origin = new URL(target);
  origin.protocol = 'https:';
  const page = await socketPage(client, target.href, origin.origin);
  const started = performance.now();
  try {
    await page.evaluate(
      ({ text, binary }) => {
        window.__samE2e.ws.send(text);
        window.__samE2e.ws.send(new Uint8Array(binary));
      },
      { text, binary }
    );
    await waitSocket(
      page,
      ({ text, binary }) => {
        const frames = window.__samE2e.messages;
        return (
          frames.some((f) => f.text === text) &&
          frames.some((f) => JSON.stringify(f.binary) === JSON.stringify(binary))
        );
      },
      { text, binary },
      client.timeoutMs
    );
    if (idleMs > 0) {
      await page.waitForTimeout(idleMs);
      const ping = `idle-${randomUUID()}`;
      await page.evaluate((ping) => window.__samE2e.ws.send(ping), ping);
      await waitSocket(
        page,
        (ping) => window.__samE2e.messages.some((f) => f.text === ping),
        ping,
        client.timeoutMs
      );
    }
    return safeEvidence({
      kind: 'preview_websocket',
      frames: idleMs > 0 ? 3 : 2,
      durationMs: performance.now() - started,
      passed: true,
    });
  } finally {
    await page.close();
  }
}
