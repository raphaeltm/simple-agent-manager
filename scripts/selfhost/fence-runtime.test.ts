/**
 * The egress fence against real tools: rendered rulesets go through `nft -c` (the kernel's own
 * parser), and celld's entrypoint runs under bash. nft needs netlink access; where neither `nft`
 * nor passwordless `sudo nft` can check a ruleset, those cases are skipped and say so. The
 * success path of celld/start.sh needs a live fence and is proven on a real stack (PR evidence).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFencePlan, renderFenceRuleset } from './egress-fence.js';

const START_SH = resolve(import.meta.dirname, '../../deploy/selfhost/celld/start.sh');
const dir = mkdtempSync(join(tmpdir(), 'fence-runtime-'));

/** How to run `nft -c -f <file>` here, or null when nothing can. */
function nftChecker(): string[] | null {
  const probe = join(dir, 'probe.nft');
  writeFileSync(probe, 'table inet sam_fence_probe {\n}\n');
  for (const command of [['nft'], ['sudo', '-n', 'nft']]) {
    const result = spawnSync(command[0]!, [...command.slice(1), '-c', '-f', probe], {
      encoding: 'utf8',
    });
    if (result.status === 0) return command;
  }
  return null;
}

const nft = nftChecker();

describe.skipIf(nft === null)('rendered rulesets pass nft -c', () => {
  const RESOLV = 'nameserver 127.0.0.53\nnameserver 2001:4860:4860::8888\n';
  it.each([
    ['defaults, bundled store', { S3_ENDPOINT: 'http://127.0.0.1:9000' }],
    ['gs:// with the metadata proxy', { CELLD_BUCKET: 'gs://b' }],
    [
      'LAN store, IPv6 allow, custom ports',
      { SAM_EGRESS_ALLOW: '[fd00::5]:8080,10.0.0.5:11434', HTTPS_PORT: '8443', CELLD_UID: '7300' },
    ],
  ])('%s', (_name, box) => {
    const plan = buildFencePlan({
      box,
      leaseRange: { start: 20000, end: 29999 },
      resolvConf: RESOLV,
      objectStore: box.S3_ENDPOINT
        ? [{ address: '127.0.0.1', port: 9000 }]
        : [{ address: '10.1.2.3', port: 9000 }],
    });
    const file = join(dir, `plan-${Math.random().toString(36).slice(2)}.nft`);
    writeFileSync(file, renderFenceRuleset(plan));
    const result = spawnSync(nft![0]!, [...nft!.slice(1), '-c', '-f', file], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});

interface Run {
  status: number | null;
  output: string;
  celldRan: boolean;
}

/** Runs start.sh with a fake celld that records that it was started. */
function runStart(env: Record<string, string>): Promise<Run> {
  const marker = join(dir, `celld-ran-${Math.random().toString(36).slice(2)}`);
  const fakeCelld = join(dir, 'fake-celld.sh');
  writeFileSync(fakeCelld, `#!/bin/bash\ntouch "$1"\n`, { mode: 0o755 });
  return new Promise((done) => {
    const child = spawn('bash', [START_SH, marker], {
      env: { PATH: process.env.PATH ?? '', SAM_CELLD_BIN: fakeCelld, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (status) => done({ status, output, celldRan: existsSync(marker) }));
  });
}

function listen(): Promise<Server> {
  return new Promise((done) => {
    const server = createServer((socket) => socket.end());
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

describe.skipIf(process.getuid?.() === 0)('celld/start.sh refuses to run celld unfenced', () => {
  let open: Server;
  let closedPort: number;

  beforeAll(async () => {
    open = await listen();
    const closed = await listen();
    closedPort = portOf(closed);
    await new Promise<void>((done) => closed.close(() => done()));
  });
  afterAll(() => new Promise<void>((done) => open.close(() => done())));

  it('without a canary configured', async () => {
    const run = await runStart({});
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('SAM_EGRESS_FENCE_CANARY');
    expect(run.celldRan).toBe(false);
  });

  it('when the canary is refused (no fence, nothing listening)', async () => {
    const run = await runStart({
      SAM_EGRESS_FENCE_CANARY: `127.0.0.1:${closedPort}`,
      SAM_EGRESS_FENCE_WAIT_SECONDS: '1',
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/egress fence is not in effect .*Connection refused.*not starting/s);
    expect(run.celldRan).toBe(false);
  });

  it('when the canary connects (no fence, the port is reachable)', async () => {
    const run = await runStart({
      SAM_EGRESS_FENCE_CANARY: `127.0.0.1:${portOf(open)}`,
      SAM_EGRESS_FENCE_WAIT_SECONDS: '1',
    });
    expect(run.status).toBe(1);
    expect(run.output).toMatch(
      /egress fence is not in effect \(connect 127\.0\.0\.1:\d+: connected\)/
    );
    expect(run.celldRan).toBe(false);
  });
});
