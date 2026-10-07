'use strict';
// Synthetic multipart receiver for the retained Playwright APIRequestContext upload shape.
// Run from the repository root; no auth, fixture IDs, payloads, or external network calls.
const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const path = require('node:path');
const { request } = require(require.resolve('@playwright/test', { paths: [path.resolve('apps/web')] }));
const payload = Buffer.alloc(4_096_000, 0x61);
const summary = { client: { statuses: [] }, proxy: [], node: [] };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
  const node = http.createServer(async (req, res) => {
    const nodeResult = {};
    summary.node.push(nodeResult);
    nodeResult.method = req.method;
    nodeResult.type = req.headers['content-type'];
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    nodeResult.bytes = bytes.length;
    const parsed = await new Response(bytes, { headers: { 'content-type': nodeResult.type } }).formData();
    nodeResult.fields = [...parsed.keys()].sort((left, right) => left.localeCompare(right));
    nodeResult.destination = parsed.get('destination');
    const file = parsed.get('files');
    nodeResult.fileName = file.name;
    nodeResult.fileType = file.type;
    nodeResult.fileBytes = file.size;
    nodeResult.fileMatches = Buffer.compare(Buffer.from(await file.arrayBuffer()), payload) === 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const nodePort = await listen(node);
  const proxy = http.createServer(async (req, res) => {
    const proxyResult = {};
    summary.proxy.push(proxyResult);
    try {
      proxyResult.type = req.headers['content-type'];
      proxyResult.contentLength = Number(req.headers['content-length']);
      const source = Readable.toWeb(req);
      proxyResult.initialLocked = source.locked;
      let seen = 0;
      const body = source.pipeThrough(new TransformStream({ transform(chunk, controller) { seen += chunk.byteLength; controller.enqueue(chunk); } }));
      proxyResult.afterPipeLocked = source.locked;
      const upstream = await fetch(`http://127.0.0.1:${nodePort}/workspaces/local/files/upload`, {
        method: 'POST', headers: { 'content-type': proxyResult.type }, body, duplex: 'half',
      });
      proxyResult.streamBytes = seen;
      proxyResult.upstreamStatus = upstream.status;
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    } catch (error) {
      proxyResult.errorName = error.name;
      proxyResult.errorCategory = String(error.message).includes('Network connection lost') ? 'network_connection_lost' : 'other';
      res.writeHead(500); res.end();
    }
  });
  const proxyPort = await listen(proxy);
  const context = await request.newContext({ baseURL: `http://127.0.0.1:${proxyPort}` });
  try {
    for (let index = 0; index < 2; index++) {
      const response = await context.fetch('/api/projects/local/sessions/local/files/upload', { method: 'POST', multipart: {
        destination: '../.private',
        files: { name: 'bundle.part-15', mimeType: 'application/octet-stream', buffer: Buffer.from(payload) },
      }, timeout: 120000 });
      summary.client.statuses.push(response.status());
      await response.json();
    }
  } finally { await context.dispose(); await close(proxy); await close(node); }
  assert.deepEqual(summary.client.statuses, [200, 200]);
  assert.equal(summary.proxy.length, 2);
  assert.equal(summary.node.length, 2);
  for (let index = 0; index < 2; index++) {
    const proxyResult = summary.proxy[index];
    const nodeResult = summary.node[index];
    assert.match(proxyResult.type, /^multipart\/form-data; boundary=/);
    assert.equal(proxyResult.contentLength, 4_096_312);
    assert.equal(proxyResult.initialLocked, false);
    assert.equal(proxyResult.afterPipeLocked, true);
    assert.equal(proxyResult.streamBytes, 4_096_312);
    assert.equal(proxyResult.upstreamStatus, 200);
    assert.equal(nodeResult.bytes, 4_096_312);
    assert.equal(nodeResult.type, proxyResult.type);
    assert.deepEqual(nodeResult.fields, ['destination', 'files']);
    assert.equal(nodeResult.destination, '../.private');
    assert.equal(nodeResult.fileName, 'bundle.part-15');
    assert.equal(nodeResult.fileType, 'application/octet-stream');
    assert.equal(nodeResult.fileBytes, 4_096_000);
    assert.equal(nodeResult.fileMatches, true);
  }
  console.log('PASS: two retained-context multipart requests crossed the local streamed proxy with complete bytes and fields');
})().catch(error => { console.error(error.name, error.message); process.exitCode = 1; });
