/**
 * Shared plumbing for the self-host live suite (`pnpm selfhost:live-test`): real frp 0.72.0
 * binaries (checksum-pinned by the same table cloud-init uses), real Caddy in Docker, and
 * stub upstreams. Nothing here talks to a SAM deployment or a cloud provider.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';

import {
  DEFAULT_FRPC_VERSION,
  FRPC_DOWNLOAD_BASE_URL,
  FRPC_RELEASES,
} from '../../../packages/cloud-init/src/reverse-tunnel';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/** Gitignored scratch directory (see .tmp/README.md). */
export const LIVE_TMP = join(REPO_ROOT, '.tmp', 'selfhost-live');

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
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  return bin;
}

export interface Running {
  child: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/** Start a process, capturing combined output for assertions and failure messages. */
export function start(command: string, args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const child = spawn(command, args, { env: { ...process.env, ...env } });
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
export function makeCertificate(dir: string, host: string): { ca: string; cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const ca = join(dir, 'ca.pem');
  const caKey = join(dir, 'ca.key');
  const key = join(dir, 'leaf.key');
  const csr = join(dir, 'leaf.csr');
  const cert = join(dir, 'leaf.pem');
  const ext = join(dir, 'leaf.ext');
  const run = (...args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=Live Test CA ${basename(dir)}`, '-keyout', caKey, '-out', ca);
  run('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-keyout', key, '-out', csr);
  writeFileSync(ext, `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  run('x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-extfile', ext, '-out', cert);
  return { ca: readFileSync(ca, 'utf8'), cert, key };
}
