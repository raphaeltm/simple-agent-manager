/**
 * Shared plumbing for the self-host live suite (`pnpm selfhost:live-test`): real frp 0.72.0
 * binaries (checksum-pinned by the same table cloud-init uses), real Caddy in Docker, and
 * stub upstreams. Nothing here talks to a SAM deployment or a cloud provider.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';

import {
  DEFAULT_FRPC_VERSION,
  FRPC_DOWNLOAD_BASE_URL,
  FRPC_RELEASES,
} from '../../../packages/cloud-init/src/reverse-tunnel';
import { BOX_LISTEN_ADDRESSES, BOX_RESERVED_PORTS } from '../box-settings.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/** Gitignored scratch directory (see .tmp/README.md). */
export const LIVE_TMP = join(REPO_ROOT, '.tmp', 'selfhost-live');
/** System tools run by absolute path, never resolved through a caller-controlled PATH. */
const TAR = '/usr/bin/tar';
const OPENSSL = '/usr/bin/openssl';
/**
 * The docker CLI from a fixed system directory, never resolved through a caller-controlled PATH
 * (as for tar and openssl). Empty when docker is not installed.
 */
export const DOCKER =
  ['/usr/bin/docker', '/usr/local/bin/docker', '/bin/docker'].find((path) => existsSync(path)) ??
  '';
export const hasDocker =
  DOCKER !== '' && spawnSync(DOCKER, ['version'], { stdio: 'ignore' }).status === 0;
/**
 * The one skip rule for tests that need Docker: skipped on a machine without a working Docker,
 * never in CI, where a missing Docker must fail the job rather than pass it empty.
 */
export const skipWithoutDocker = !hasDocker && !process.env.CI;

/**
 * Host variables a test child process may inherit (as the deploy's celldChildEnv does): what the
 * tools need to run and find their caches. Host secrets and cloud credentials stay out.
 */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'RUST_LOG'];

/** The allowlisted host environment (plus any DOCKER_* setting) with `extra` on top. */
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (INHERITED_ENV.includes(name) || name.startsWith('DOCKER_'))) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}

/** A free loopback TCP port (the kernel picks it; closed before returning). */
export async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? done(address.port) : fail(new Error('no port'))
      );
    });
  });
}

/** Directory holding `frpc` and `frps` for the pinned release, downloaded once and verified. */
export async function frpBinaries(): Promise<{ frpc: string; frps: string }> {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const release = FRPC_RELEASES[DEFAULT_FRPC_VERSION];
  if (!release) throw new Error(`no pinned checksum for frp ${DEFAULT_FRPC_VERSION}`);
  const name = `frp_${DEFAULT_FRPC_VERSION}_linux_${arch}`;
  const dir = join(LIVE_TMP, name);
  const bin = { frpc: join(dir, name, 'frpc'), frps: join(dir, name, 'frps') };
  if (existsSync(bin.frpc) && existsSync(bin.frps)) return bin;
  mkdirSync(dir, { recursive: true });
  const response = await fetch(`${FRPC_DOWNLOAD_BASE_URL}/v${DEFAULT_FRPC_VERSION}/${name}.tar.gz`);
  if (!response.ok) throw new Error(`frp download failed: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(tarball).digest('hex');
  if (digest !== release[arch]) throw new Error(`frp ${name} checksum mismatch: ${digest}`);
  const archive = join(dir, `${name}.tar.gz`);
  writeFileSync(archive, tarball);
  execFileSync(TAR, ['-xzf', archive, '-C', dir]);
  return bin;
}

export interface Running {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/** Start a process, capturing combined output for assertions and failure messages. */
export function start(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(command, args, { env: childEnv(env) });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return {
    child,
    output: () => output,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5000).then(() => child.kill('SIGKILL'))]);
    },
  };
}

const CADDY_IMAGE = 'sam-selfhost-caddy:live-test';
/** The box's Caddy config directory, mounted read-only at /etc/caddy as compose mounts it. */
export const CADDY_DIR = join(REPO_ROOT, 'deploy/selfhost/caddy');
let caddyBuilt = false;

/**
 * The box's Caddy image, built from deploy/selfhost/caddy/Dockerfile exactly as
 * `docker compose build caddy` builds it (digest-pinned bases, version-pinned modules, including
 * the rate-limit module sam.d/frp.caddy needs). Built once per test file; Docker's layer cache
 * makes later builds instant.
 */
export function caddyImage(): string {
  if (!caddyBuilt) {
    execFileSync(DOCKER, ['build', '-q', '-t', CADDY_IMAGE, CADDY_DIR], { stdio: 'pipe' });
    caddyBuilt = true;
  }
  return CADDY_IMAGE;
}

/** Lease range for live Caddy runs: below the kernel's ephemeral range, so freePort never hits it. */
export const LIVE_TUNNEL_RANGE = { start: 20000, end: 20099 };

/**
 * Every setting caddy/start.sh checks, on free ports: each box port docker-compose.yml passes
 * (BOX_RESERVED_PORTS; a listen address such as SAM_MX_LISTEN gets `:<port>`) and the lease
 * range from gateway.env. Callers override what their test probes.
 */
export async function caddyBoxEnv(): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    REVERSE_TUNNEL_PORT_RANGE_START: String(LIVE_TUNNEL_RANGE.start),
    REVERSE_TUNNEL_PORT_RANGE_END: String(LIVE_TUNNEL_RANGE.end),
  };
  for (const name of Object.keys(BOX_RESERVED_PORTS)) {
    const port = String(await freePort());
    env[name] = BOX_LISTEN_ADDRESSES.includes(name) ? `:${port}` : port;
  }
  return env;
}

/** The `docker run` arguments that start the box's Caddy as docker-compose.yml runs it. */
function caddyRunArgs(name: string, env: Record<string, string>, detach: boolean): string[] {
  return [
    'run',
    detach ? '-d' : '--rm',
    '--name',
    name,
    '--network',
    'host',
    // compose: only the capability to bind 80/443.
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '-v',
    `${CADDY_DIR}:/etc/caddy:ro`,
    // compose: start.sh checks the settings, then execs Caddy.
    '--entrypoint',
    '/bin/sh',
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    caddyImage(),
    '/etc/caddy/start.sh',
  ];
}

/** Where Caddy's internal CA (tls/internal.caddy) keeps its root certificate, in the container. */
const CADDY_LOCAL_ROOT = '/data/caddy/pki/authorities/local/root.crt';

/** What httpsGet needs to reach one Caddy: its HTTPS port and the CA that signs its certificate. */
export interface HttpsTarget {
  /** The HTTPS port (env.HTTPS_PORT). */
  https: number;
  /** PEM of the root that signs the certificate Caddy serves (its internal CA). */
  ca: string;
}

export interface CaddyRun extends HttpsTarget {
  container: string;
  stdout: () => string;
  stderr: () => string;
  /** Removes the container (idempotent). */
  stop: () => void;
}

/**
 * Start the box's Caddy image through start.sh, exactly as docker-compose.yml does, with `env`
 * (start with caddyBoxEnv() so start.sh's checks pass; SAM_TLS_MODE internal), read the root of
 * its internal CA, and wait until it answers HTTPS on env.HTTPS_PORT with a certificate that root
 * verifies, with any status (a stack whose upstream is down answers 502).
 */
export async function startCaddy(env: Record<string, string>): Promise<CaddyRun> {
  const container = `sam-live-caddy-${randomBytes(4).toString('hex')}`;
  execFileSync(DOCKER, caddyRunArgs(container, env, true), { stdio: 'pipe' });
  const logs = () => spawnSync(DOCKER, ['logs', container], { encoding: 'utf8' });
  const run: CaddyRun = {
    container,
    https: Number(env.HTTPS_PORT),
    ca: '',
    stdout: () => logs().stdout ?? '',
    stderr: () => logs().stderr ?? '',
    stop: () => void spawnSync(DOCKER, ['rm', '-f', container], { stdio: 'ignore' }),
  };
  try {
    run.ca = await waitFor(
      "Caddy's internal CA root",
      () => {
        const read = spawnSync(DOCKER, ['exec', container, 'cat', CADDY_LOCAL_ROOT], {
          encoding: 'utf8',
        });
        return read.status === 0 && read.stdout.includes('BEGIN CERTIFICATE') ? read.stdout : '';
      },
      120_000,
      run.stderr
    );
    await waitFor(
      'Caddy to serve TLS',
      async () => {
        try {
          return (await httpsGet(run, `app.${env.SAM_DOMAIN}`, '/')).status > 0;
        } catch {
          return false;
        }
      },
      120_000,
      run.stderr
    );
  } catch (error) {
    run.stop();
    throw error;
  }
  return run;
}

/** Run the box's Caddy image in the foreground until start.sh or Caddy exits. */
export function runCaddyToExit(env: Record<string, string>): {
  status: number | null;
  stderr: string;
} {
  const name = `sam-live-caddy-${randomBytes(4).toString('hex')}`;
  const run = spawnSync(DOCKER, caddyRunArgs(name, env, false), {
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: run.status, stderr: run.stderr ?? '' };
}

export interface HttpsReply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * One HTTPS request to Caddy on 127.0.0.1:`target.https` for `host` (SNI and Host), with the exact
 * raw `path` (Node does not normalize it). The certificate is verified against Caddy's internal CA
 * (`target.ca`) and must name `host`, so a test cannot pass against the wrong site. For a request
 * with WebSocket upgrade headers, a 101 reply's socket is closed at once.
 */
export function httpsGet(
  target: HttpsTarget,
  host: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<HttpsReply> {
  return new Promise((done, fail) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port: target.https,
      // SNI, and the name the certificate is checked against (DNS names are case-insensitive).
      servername: host.toLowerCase(),
      ca: target.ca,
      method: 'GET',
      path,
      headers: { Host: host, ...headers },
    });
    req.on('upgrade', (res: IncomingMessage, socket: Duplex) => {
      socket.destroy();
      done({ status: res.statusCode ?? 0, headers: res.headers, body: '' });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Poll until `check` is truthy or the deadline passes. */
export async function waitFor<T>(
  what: string,
  check: () => T | Promise<T>,
  timeoutMs = 30_000,
  context: () => string = () => ''
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${context()}`);
    await sleep(200);
  }
}

/** A private CA plus a leaf for `host`, created with the system openssl. */
export function makeCertificate(
  dir: string,
  host: string
): { ca: string; cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const ca = join(dir, 'ca.pem');
  const caKey = join(dir, 'ca.key');
  const key = join(dir, 'leaf.key');
  const csr = join(dir, 'leaf.csr');
  const cert = join(dir, 'leaf.pem');
  const ext = join(dir, 'leaf.ext');
  const run = (...args: string[]) => execFileSync(OPENSSL, args, { stdio: 'pipe' });
  run(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    `/CN=Live Test CA ${basename(dir)}`,
    '-keyout',
    caKey,
    '-out',
    ca
  );
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-keyout', key, '-out', csr);
  writeFileSync(
    ext,
    `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`
  );
  run(
    'x509',
    '-req',
    '-in',
    csr,
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    ext,
    '-out',
    cert
  );
  return { ca: readFileSync(ca, 'utf8'), cert, key };
}
