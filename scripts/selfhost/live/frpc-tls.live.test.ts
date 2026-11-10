/**
 * Live: the frpc.toml cloud-init renders for a reverse-tunnel node, run by the real pinned frpc,
 * must refuse a control plane whose certificate does not chain to a CA it trusts (or names
 * another host), and must log in when it does. frpc trusts the system pool (useSystemCa);
 * SSL_CERT_FILE replaces that pool for the test, which is how Go's crypto/x509 reads it on
 * Linux. A TLS terminator in front of a real frps stands in for the box's Caddy.
 *
 * Also records what frps 0.72.0 actually sends the server plugin, so the NewWorkConn
 * authorization in apps/api/src/services/node-reverse-tunnel-authz.ts rests on observed fields.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { generateCloudInit } from '../../../packages/cloud-init/src/generate';
import {
  freePort,
  frpBinaries,
  LIVE_TMP,
  makeCertificate,
  type Running,
  start,
  waitFor,
} from './harness';

const NODE_ID = '01M72NODELIVETLS0000000001';
const INCARNATION = '0f6c0a8e-2a4b-4c55-9d6e-1b2c3d4e5f60';
// Built at runtime so no secret-shaped literal sits in the source (gitleaks).
const CREDENTIAL = ['Live', 'credential', 'fixture', '0123456789abcdef'].join('_');

interface PluginCall {
  op: string;
  content: Record<string, unknown>;
}

let work: string;
let bins: { frpc: string; frps: string };
let frps: Running;
let plugin: Server;
let terminator: TlsServer | null = null;
let echo: ReturnType<typeof createTcpServer>;
const calls: PluginCall[] = [];
let ports: { frps: number; plugin: number; tls: number; lease: number; local: number };
const running: Running[] = [];

beforeAll(async () => {
  bins = await frpBinaries();
  mkdirSync(LIVE_TMP, { recursive: true });
  work = mkdtempSync(join(LIVE_TMP, 'frpc-tls-'));
  ports = {
    frps: await freePort(),
    plugin: await freePort(),
    tls: await freePort(),
    lease: await freePort(),
    local: await freePort(),
  };
  // Stand-in for the SAM plugin: allows everything, records every op it is asked about.
  plugin = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { op: string; content: Record<string, unknown> };
      calls.push({ op: parsed.op, content: parsed.content });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ reject: false, unchange: true }));
    });
  });
  await new Promise<void>((done) => plugin.listen(ports.plugin, '127.0.0.1', done));
  // The node agent's loopback listener frpc forwards to.
  echo = createTcpServer((socket) => socket.end('node-agent-says-hi'));
  await new Promise<void>((done) => echo.listen(ports.local, '127.0.0.1', done));
  const frpsToml = join(work, 'frps.toml');
  writeFileSync(
    frpsToml,
    [
      'bindAddr = "127.0.0.1"',
      `bindPort = ${ports.frps}`,
      'proxyBindAddr = "127.0.0.1"',
      `allowPorts = [ { start = ${ports.lease}, end = ${ports.lease} } ]`,
      'transport.tls.force = false',
      '[[httpPlugins]]',
      'name = "recorder"',
      `addr = "http://127.0.0.1:${ports.plugin}"`,
      'path = "/plugin"',
      'ops = ["Login", "NewProxy", "Ping", "NewWorkConn"]',
    ].join('\n')
  );
  frps = start(bins.frps, ['-c', frpsToml]);
  await waitFor(
    'frps to listen',
    () => frps.output().includes('frps started successfully'),
    15_000,
    frps.output
  );
});

afterEach(async () => {
  for (const proc of running.splice(0)) await proc.stop();
  await new Promise<void>((done) => (terminator ? terminator.close(() => done()) : done()));
  terminator = null;
  calls.length = 0;
});

afterAll(async () => {
  await frps?.stop();
  await new Promise<void>((done) => plugin?.close(() => done()));
  await new Promise<void>((done) => echo?.close(() => done()));
  if (work) rmSync(work, { recursive: true, force: true });
});

/** TLS on ports.tls, plain TCP to frps: what Caddy does in front of frps on the box. */
async function serveTls(cert: string, key: string) {
  terminator = createTlsServer({ cert: readFileSync(cert), key: readFileSync(key) }, (socket) => {
    const upstream = connect(ports.frps, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  terminator.on('tlsClientError', () => {});
  await new Promise<void>((done) => terminator!.listen(ports.tls, '127.0.0.1', done));
}

/** The exact frpc.toml cloud-init writes for this node, pointed at the local terminator. */
function generatedFrpcToml(): string {
  const parsed = YAML.parse(
    generateCloudInit({
      nodeId: NODE_ID,
      nodeRuntimeIncarnationId: INCARNATION,
      hostname: 'sam-live-node',
      controlPlaneUrl: `https://localhost:${ports.tls}`,
      jwksUrl: `https://localhost:${ports.tls}/.well-known/jwks.json`,
      callbackToken: 'callback-token',
      swapSizeMb: '0',
      reverseTunnelCredential: CREDENTIAL,
      reverseTunnelRemotePort: String(ports.lease),
      reverseTunnelLocalPort: String(ports.local),
    })
  ) as { write_files: Array<{ path: string; content: string }> };
  const toml = parsed.write_files.find((f) => f.path === '/etc/sam/frpc/frpc.toml')?.content;
  if (!toml) throw new Error('cloud-init wrote no frpc.toml');
  expect(toml).toContain('transport.tls.useSystemCa = true');
  expect(toml).toContain('serverAddr = "localhost"');
  return toml;
}

function runFrpc(trustedCaPem: string): Running {
  const dir = mkdtempSync(join(work, 'frpc-'));
  const config = join(dir, 'frpc.toml');
  const trust = join(dir, 'trusted.pem');
  writeFileSync(config, generatedFrpcToml());
  writeFileSync(trust, trustedCaPem);
  const proc = start(bins.frpc, ['-c', config], {
    SAM_REVERSE_TUNNEL_CREDENTIAL: CREDENTIAL,
    SSL_CERT_FILE: trust,
    SSL_CERT_DIR: dir,
  });
  running.push(proc);
  return proc;
}

describe('frpc certificate verification (generated frpc.toml, real frpc 0.72.0)', () => {
  it('refuses a server whose certificate does not chain to a trusted CA', async () => {
    const server = makeCertificate(join(work, 'untrusted'), 'localhost');
    const other = makeCertificate(join(work, 'other-ca'), 'localhost');
    await serveTls(server.cert, server.key);
    const frpc = runFrpc(other.ca);
    await waitFor(
      'a certificate error',
      () => /x509|certificate/i.test(frpc.output()),
      30_000,
      frpc.output
    );
    expect(frpc.output()).not.toContain('login to server success');
    expect(calls.filter((c) => c.op === 'Login')).toEqual([]);
  });

  it('refuses a trusted certificate issued for another host', async () => {
    const server = makeCertificate(join(work, 'wrong-host'), 'not-the-box.test');
    await serveTls(server.cert, server.key);
    const frpc = runFrpc(server.ca);
    await waitFor(
      'a certificate error',
      () => /x509|certificate/i.test(frpc.output()),
      30_000,
      frpc.output
    );
    expect(calls.filter((c) => c.op === 'Login')).toEqual([]);
  });

  it('control: logs in and serves the lease port when the certificate chains to a trusted CA', async () => {
    const server = makeCertificate(join(work, 'trusted'), 'localhost');
    await serveTls(server.cert, server.key);
    const frpc = runFrpc(server.ca);
    await waitFor(
      'frpc login',
      () => frpc.output().includes('login to server success'),
      30_000,
      frpc.output
    );
    await waitFor(
      'the lease proxy',
      () => calls.some((c) => c.op === 'NewProxy'),
      15_000,
      frpc.output
    );
    const login = calls.find((c) => c.op === 'Login')!.content;
    expect(login.user).toBe(NODE_ID);
    expect(login.metas).toEqual({
      node_id: NODE_ID,
      incarnation: INCARNATION,
      credential: CREDENTIAL,
    });

    // poolCount: work connections are opened, and authorized, before any user connection.
    await waitFor(
      'the pooled work connections',
      () => calls.filter((c) => c.op === 'NewWorkConn').length >= 2,
      15_000,
      frpc.output
    );
    // A connection through the lease port is served by a pooled work connection.
    const reply = await new Promise<string>((done, fail) => {
      const socket = connect(ports.lease, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
      socket.on('end', () => done(data));
      socket.on('error', fail);
    });
    expect(reply).toBe('node-agent-says-hi');
    const workConn = calls.find((c) => c.op === 'NewWorkConn')?.content;
    // The fields the SAM plugin relies on, as frps 0.72.0 sends them: `user` is the control
    // session's login identity; nothing describes the dialing connection.
    expect(Object.keys(workConn ?? {}).sort()).toEqual(['run_id', 'user']);
    const user = workConn!.user as { user: string; metas: unknown; run_id: string };
    expect(user.user).toBe(NODE_ID);
    expect(user.metas).toEqual(login.metas);
    expect(user.run_id).toMatch(/^[0-9a-f]{16}$/);
    expect(workConn!.run_id).toBe(user.run_id);
  });
});
