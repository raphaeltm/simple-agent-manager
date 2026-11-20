/**
 * Finding F9 is closed by the key agent's framed protocol: no `fetch` the Worker makes can start
 * with its NUL preamble (deploy/selfhost/key-agent/server.ts). A raw socket could, if some code
 * wrote attacker-chosen bytes first to an attacker-chosen loopback port. So raw sockets stay on an
 * explicit list (security review M-1), each one checked:
 *
 * - the SMTP client reads the server's 220 greeting before it writes anything, and the agent
 *   never speaks first, so a box SMTP setting pointed at the agent times out (tested below);
 * - runtime-secrets-socket.ts is the agent's own client.
 *
 * A new `cloudflare:sockets` import fails this test until it is reviewed and added here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';

import { probeSmtpRelay } from '@simple-agent-manager/agent-email/definitions';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../../../..');
const ALLOWED = [
  'apps/api/src/selfhost/runtime-secrets-socket.ts',
  'packages/agent-email/src/smtp-client.ts',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

describe('raw sockets in Worker code', () => {
  it('only the reviewed modules import cloudflare:sockets', () => {
    const roots = [
      join(REPO, 'apps/api/src'),
      ...readdirSync(join(REPO, 'packages')).map((p) => join(REPO, 'packages', p, 'src')),
    ].filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory());
    const files = roots.flatMap(sources);
    // Liveness: the scan saw the tree (a broken root must not pass as "nothing found").
    expect(files.length).toBeGreaterThan(500);
    const importers = files
      .filter((file) =>
        /from\s+['"]cloudflare:sockets['"]|import\(\s*['"]cloudflare:sockets['"]/.test(
          readFileSync(file, 'utf8')
        )
      )
      .map((file) => relative(REPO, file))
      .sort();
    expect(importers).toEqual(ALLOWED);
  });

  // The SMTP client against a server that never speaks (as the key agent never does): it must
  // time out having written nothing, so a box SMTP setting pointed at the agent's port cannot
  // put bytes on it.
  it('the SMTP client writes nothing to a server that does not greet first', async () => {
    const received: Buffer[] = [];
    let connected = 0;
    const silent = createServer((socket) => {
      connected += 1;
      socket.on('data', (chunk: Buffer) => received.push(chunk));
    });
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done));
    try {
      const port = (silent.address() as AddressInfo).port;
      await expect(
        probeSmtpRelay(
          { host: '127.0.0.1', port, tls: 'none', credentials: null, from: 'sam@example.com' },
          { envelopeFrom: 'sam@example.com', envelopeTo: 'owner@example.com' },
          { timeoutMs: 300, heloName: 'sam.example.com' }
        )
      ).rejects.toThrow(/timed out/);
      expect(connected).toBe(1); // liveness: it did reach this server
      expect(Buffer.concat(received)).toHaveLength(0);
    } finally {
      await new Promise<void>((done) => silent.close(() => done()));
    }
  });
});
