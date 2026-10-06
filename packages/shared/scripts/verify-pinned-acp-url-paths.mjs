// CLAUDE_ACP_PACKAGE_DIR=/absolute/path CODEX_ACP_PACKAGE_DIR=/absolute/path \
//   node packages/shared/scripts/verify-pinned-acp-url-paths.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const claudeDir = process.env.CLAUDE_ACP_PACKAGE_DIR;
const codexDir = process.env.CODEX_ACP_PACKAGE_DIR;
for (const [dir, version] of [[claudeDir, '0.81.2'], [codexDir, '2.1.1']]) {
  assert.ok(dir && isAbsolute(dir) && statSync(dir).isDirectory(), 'installed adapter path required');
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version, version);
}

const { ClaudeAcpAgent } = await import(pathToFileURL(join(claudeDir, 'dist/lib.js')).href);
const requests = [];
const agent = new ClaudeAcpAgent({
  createElicitation: async (request) => { requests.push(request); return { action: 'accept' }; },
});
const remoteRequest = { mode: 'url', message: 'Approve remote fixture',
  url: 'https://auth.example.com/approve?state=SECRET_URL_CANARY', elicitationId: 'remote-1' };
const forwarded = await agent.handleMcpElicitation('pinned-session', { form: false, url: true })(
  remoteRequest, { signal: new AbortController().signal });
assert.deepEqual(requests[0], { ...remoteRequest, sessionId: 'pinned-session' });
assert.equal(forwarded.action, 'accept');
const refused = await agent.handleMcpElicitation('pinned-session', { form: false, url: false })(
  remoteRequest, { signal: new AbortController().signal });
assert.equal(refused.action, 'decline');
assert.equal(requests.length, 1);
const cancelled = new AbortController();
cancelled.abort();
const cancelledResult = await agent.handleMcpElicitation('pinned-session', { form: false, url: true })(
  remoteRequest, { signal: cancelled.signal });
assert.equal(cancelledResult.action, 'cancel');

const claudeSource = readFileSync(join(claudeDir, 'dist/acp-agent.js'), 'utf8');
assert.match(claudeSource, /case "elicitation_complete": \{[\s\S]*?this\.client\.completeElicitation\(\{[\s\S]*?elicitationId: message\.elicitation_id/);
assert.match(claudeSource, /async function authenticateMcpServer\([\s\S]*?mcpAuthenticate\(serverName\)/);
const codexSource = readFileSync(join(codexDir, 'dist/index.js'), 'utf8');
assert.match(codexSource, /if \(params\.mode === "url" && result2\.action === "accept"\) \{\s*this\.trackUrlElicitation/);
assert.match(codexSource, /case "serverRequest\/resolved":\s*await this\.completeUrlElicitations/);
assert.match(codexSource, /completeElicitation: async \(\) => \{[\s\S]*?this\.connection\.notify\(methods\.client\.elicitation\.complete/);

console.log('Pinned Claude URL forwarding ran; Codex completion and separate localhost branches match installed source.');

// A deterministic externally completing HTTPS service drives the installed
// Claude adapter's MCP URL forwarding AND its real SDK-message consumer branch.
// The test client maps the eligible public fixture host to a local TLS listener;
// production SAM never performs this fetch or follows its redirects.
const certDir = mkdtempSync(join(tmpdir(), 'sam-acp-url-fixture-'));
let service;
try {
  const keyPath = join(certDir, 'fixture.key');
  const certPath = join(certDir, 'fixture.crt');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', '1', '-subj', '/CN=auth.example.test', '-addext', 'subjectAltName=DNS:auth.example.test',
    '-keyout', keyPath, '-out', certPath],
  { stdio: 'ignore' });
  let queued = [];
  let waiting;
  const query = {
    next: () => queued.length ? Promise.resolve({ value: queued.shift(), done: false }) :
      new Promise((resolve) => { waiting = resolve; }),
  };
  const push = (message) => {
    if (waiting) { const resolve = waiting; waiting = undefined; resolve({ value: message, done: false }); }
    else queued.push(message);
  };
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  service = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
    if (req.url === '/approve') { res.writeHead(200); res.end('Open /complete to finish'); return; }
    if (req.url === '/complete') {
      res.writeHead(200); res.end('External service completed');
      push({ type: 'system', subtype: 'elicitation_complete', elicitation_id: 'https-service-1' });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => service.listen(0, '127.0.0.1', resolve));
  const port = service.address().port;
  const navigate = (path) => new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: 'auth.example.test', port, path, method: 'GET',
      lookup: (_hostname, options, callback) => {
        const done = typeof options === 'function' ? options : callback;
        if (typeof options === 'object' && options.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
        else done(null, '127.0.0.1', 4);
      },
      ca: readFileSync(certPath),
      headers: { Host: 'auth.example.test' } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end();
  });
  const completed = [];
  const serviceAgent = new ClaudeAcpAgent({
    createElicitation: async (request) => {
      assert.equal(request.url, 'https://auth.example.test/approve');
      assert.equal(request.elicitationId, 'https-service-1');
      assert.equal(await navigate('/approve'), 200);
      assert.equal(await navigate('/complete'), 200);
      return { action: 'accept' };
    },
    completeElicitation: async (notification) => { completed.push(notification); resolveCompletion(); },
    sessionUpdate: async () => {},
  }, { error: (message) => { throw new Error(message); } });
  serviceAgent.clientCapabilities = { elicitation: { url: {} } };
  const session = { query, cancelController: new AbortController(), turnQueue: [],
    liveBackgroundTasks: new Map(), taskState: new Map(), emittedToolCalls: new Set(),
    orphanCommands: new Map(), pendingEmptyInterruptionDiagnosticCommands: new Map() };
  serviceAgent.sessions.fixture = session;
  void serviceAgent.runConsumer(session, { sessionId: 'fixture' });
  const result = await serviceAgent.handleMcpElicitation('fixture', { form: false, url: true })(
    { mode: 'url', message: 'Approve remote service', url: 'https://auth.example.test/approve',
      elicitationId: 'https-service-1' }, { signal: new AbortController().signal });
  await Promise.race([completion, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('pinned wrapper did not forward external completion')), 2000))]);
  assert.equal(result.action, 'accept');
  assert.deepEqual(completed, [{ elicitationId: 'https-service-1' }]);
  console.log('Pinned Claude external HTTPS fixture completed through create and elicitation/complete paths.');
} finally {
  if (service) await new Promise((resolve) => service.close(resolve));
  rmSync(certDir, { recursive: true, force: true });
}
