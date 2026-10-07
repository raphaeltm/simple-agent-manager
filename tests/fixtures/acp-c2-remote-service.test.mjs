import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.ACP_C2_FIXTURE_INNER) {
  const directory = mkdtempSync(join(tmpdir(), 'acp-c2-remote-'));
  try {
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync(
      '/usr/bin/openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-sha256',
        '-days',
        '1',
        '-subj',
        '/CN=auth.example.test',
        '-addext',
        'subjectAltName=DNS:auth.example.test,IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' }
    );
    const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      env: {
        ...process.env,
        ACP_C2_FIXTURE_INNER: '1',
        ACP_C2_FIXTURE_KEY: key,
        ACP_C2_FIXTURE_CERT: cert,
        NODE_EXTRA_CA_CERTS: cert,
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    process.stdout.write(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
} else {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ElicitRequestSchema, ElicitationCompleteNotificationSchema } =
    await import('@modelcontextprotocol/sdk/types.js');
  const { createFixtureServer } = await import('./acp-c2-remote-service.mjs');
  const events = [];
  const requests = [];
  let fixtureNow = Date.now();
  const fixture = createFixtureServer({
    publicUrl: 'https://auth.example.test',
    tlsKey: readFileSync(process.env.ACP_C2_FIXTURE_KEY),
    tlsCert: readFileSync(process.env.ACP_C2_FIXTURE_CERT),
    mcpToken: 'test-only-token',
    maxEvents: 4,
    now: () => fixtureNow,
    log: (event) => events.push(event),
  });
  await new Promise((resolve) => fixture.listener.listen(0, '127.0.0.1', resolve));
  const port = fixture.listener.address().port;
  const localBase = `https://127.0.0.1:${port}`;
  const client = new Client(
    { name: 'c2-fixture-check', version: '1.0.0' },
    { capabilities: { elicitation: { url: {} } } }
  );
  let approve;
  let resolveAnswer;
  const requested = new Promise((resolve) => {
    approve = resolve;
  });
  const answered = new Promise((resolve) => {
    resolveAnswer = resolve;
  });
  const completions = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    requests.push(request.params);
    approve(request.params);
    return answered;
  });
  client.setNotificationHandler(ElicitationCompleteNotificationSchema, (notification) => {
    completions.push(notification.params.elicitationId);
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${localBase}/mcp`), {
    requestInit: { headers: { 'X-ACP-C2-Fixture-Auth': 'Bearer test-only-token' } },
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools[0].name, 'request_remote_url');
    const toolResult = client.callTool({ name: 'request_remote_url', arguments: {} });
    const request = await requested;
    assert.equal(request.mode, 'url');
    assert.equal(new URL(request.url).host, 'auth.example.test');
    const state = new URL(request.url).searchParams.get('state');
    assert.ok(state);
    const page = await fetch(`${localBase}/approve?state=${state}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Opening this page does not complete it/);
    assert.deepEqual(completions, []);
    const complete = await fetch(`${localBase}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ state }),
    });
    assert.equal(complete.status, 200);
    await complete.text();
    for (let index = 0; index < 100 && completions.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(completions, [request.elicitationId]);
    resolveAnswer({ action: 'accept' });
    assert.equal((await toolResult).isError, undefined);
    const duplicate = await fetch(`${localBase}/complete`, {
      method: 'POST',
      body: new URLSearchParams({ state }),
    });
    assert.equal(duplicate.status, 200);
    assert.equal(completions.length, 1);
    const replay = await fetch(`${localBase}/admin/replay`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-only-token' },
      body: new URLSearchParams({ state }),
    });
    assert.equal(replay.status, 204);
    assert.equal((await fetch(`${localBase}/admin/replay`, {
      method: 'POST', body: new URLSearchParams({ state }),
    })).status, 401);
    for (let index = 0; index < 100 && completions.length < 2; index++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(completions, [request.elicitationId, request.elicitationId]);
    assert.deepEqual(
      fixture.events.map((event) => event.kind),
      ['service_completed', 'completion_notified', 'accepted', 'completion_replayed']
    );
    assert.equal(events.length, 5);
    fixtureNow += 20 * 60 * 1000 + 1;
    assert.equal((await fetch(`${localBase}/admin/replay`, {
      method: 'POST', headers: { Authorization: 'Bearer test-only-token' },
      body: new URLSearchParams({ state }),
    })).status, 409);
    const secondToolResult = client.callTool({ name: 'request_remote_url', arguments: {} });
    for (let index = 0; index < 100 && requests.length < 2; index++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(requests.length, 2);
    const secondState = new URL(requests[1].url).searchParams.get('state');
    assert.ok(secondState);
    assert.equal((await secondToolResult).isError, undefined);
    fixtureNow += 20 * 60 * 1000 + 1;
    assert.equal((await fetch(`${localBase}/complete`, {
      method: 'POST', body: new URLSearchParams({ state: secondState }),
    })).status, 404);
    assert.equal((await fetch(`${localBase}/mcp`)).status, 401);
    process.stdout.write(
      'Disposable HTTPS MCP fixture: early service completion, SDK notification, answer, duplicate and auth checks passed.\n'
    );
  } finally {
    await client.close();
    await fixture.close();
    await new Promise((resolve) => fixture.listener.close(resolve));
  }
  const proxyFixture = createFixtureServer({
    publicUrl: 'https://ws-c2fixture--8080.sammy.party',
    mcpToken: 'test-only-token',
    samPortProxy: true,
    formTool: true,
    log: () => {},
  });
  try {
    await new Promise((resolve) => proxyFixture.listener.listen(0, '127.0.0.1', resolve));
    const proxyBase = `http://127.0.0.1:${proxyFixture.listener.address().port}`;
    assert.equal((await fetch(`${proxyBase}/mcp`)).status, 401);
    assert.equal((await fetch(`${proxyBase}/approve?state=unknown`)).status, 404);
    const proxyClient = new Client({ name: 'c2-proxy-check', version: '1.0.0' },
      { capabilities: { elicitation: { url: {} } } });
    let unsupportedCallbacks = 0;
    proxyClient.setRequestHandler(ElicitRequestSchema, async () => {
      unsupportedCallbacks++;
      return { action: 'cancel' };
    });
    try {
      await proxyClient.connect(new StreamableHTTPClientTransport(new URL(`${proxyBase}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer test-only-token' } },
      }));
      assert.equal((await proxyClient.listTools()).tools[0].name, 'request_remote_url');
      const unsupported = await proxyClient.callTool({ name: 'request_form', arguments: {} });
      assert.equal(unsupported.isError, true);
      assert.equal(unsupportedCallbacks, 0);
      assert.ok(!proxyFixture.events.some(event => event.kind === 'cancelled'));
      const errorEvent = proxyFixture.events.at(-1);
      assert.equal(errorEvent.kind, 'request_error');
      assert.equal(errorEvent.mode, 'form');
      assert.equal(errorEvent.formSupported, false);
      assert.equal(errorEvent.urlSupported, true);
      assert.equal(errorEvent.errorCode, null);
      assert.deepEqual(Object.keys(errorEvent).sort(),
        ['kind', 'elicitationId', 'at', 'mode', 'formSupported', 'urlSupported', 'errorCode'].sort());
      assert.ok(!JSON.stringify(errorEvent).includes('test-only-token'));
    } finally {
      await proxyClient.close();
    }
    for (const action of ['accept', 'cancel']) {
      const formClient = new Client({ name: 'form-check', version: '1.0.0' },
        { capabilities: { elicitation: { form: {} } } });
      let callbacks = 0;
      formClient.setRequestHandler(ElicitRequestSchema, async () => {
        callbacks++;
        return action === 'accept' ? { action, content: { response: 'safe-canary' } } : { action };
      });
      try {
        await formClient.connect(new StreamableHTTPClientTransport(new URL(`${proxyBase}/mcp`), {
          requestInit: { headers: { Authorization: 'Bearer test-only-token' } },
        }));
        const unsupportedUrl = await formClient.callTool({ name: 'request_remote_url', arguments: {} });
        assert.equal(unsupportedUrl.isError, true);
        assert.equal(callbacks, 0);
        assert.equal(proxyFixture.events.at(-1).kind, 'request_error');
        assert.equal(proxyFixture.events.at(-1).mode, 'url');
        assert.equal(proxyFixture.events.at(-1).urlSupported, false);
        const result = await formClient.callTool({ name: 'request_form', arguments: {} });
        assert.equal(callbacks, 1);
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].text, `Fixture form ${action}.`);
        assert.equal(proxyFixture.events.at(-1).kind, action === 'accept' ? 'accepted' : 'cancelled');
      } finally {
        await formClient.close();
      }
    }
  } finally {
    await proxyFixture.close();
    await new Promise((resolve) => proxyFixture.listener.close(resolve));
  }
}
