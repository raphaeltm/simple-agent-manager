/**
 * Sealed secrets on the real runtime: a celld 0.6.3 node (pinned, checksum-verified) over the
 * box's object store (the MinIO image pinned in docker-compose.yml), the real key agent
 * (deploy/selfhost/key-agent/server.ts, file provider) and a Worker built from the same
 * runtime-secrets module the API's celld entry uses. Proves, end to end:
 *
 * - the Worker and a Durable Object get the secrets at runtime, and no deploy var carries one;
 * - a copy of the fleet bucket holds none of them, while a plain var is stored in plaintext
 *   there (the control: this is why secrets cannot be vars on celld);
 * - with the agent down a fresh isolate answers 503 SECRETS_UNAVAILABLE, and serves again as
 *   soon as the agent is back;
 * - the agent refuses a peer uid it does not allow, on real loopback sockets.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCelldBinary } from '../celld-binary.js';
import {
  celldNode,
  hasDocker,
  type ObjectStore,
  sealBundle,
  type SealedBundle,
  startKeyAgent,
  startObjectStore,
  writeProject,
} from './celld-lab';
import { freePort, LIVE_TMP, REPO_ROOT, type Running, sleep, waitFor } from './harness';

const RUNTIME_SECRETS = join(REPO_ROOT, 'apps/api/src/selfhost/runtime-secrets.ts');

const WORKER = `
import { wrapDurableObject, wrapWorker } from ${JSON.stringify(RUNTIME_SECRETS)};
const isolateId = crypto.randomUUID();
let served = 0;
class Probe {
  constructor(_ctx, env) { this.env = env; }
  async fetch() { return Response.json({ doSecret: typeof this.env.LIVE_SECRET }); }
}
export const ProbeDO = wrapDurableObject(Probe);
export default wrapWorker({
  async fetch(request, env) {
    served += 1;
    if (new URL(request.url).pathname === '/do') {
      return await env.PROBE_DO.get(env.PROBE_DO.idFromName('one')).fetch('https://do/');
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.LIVE_SECRET ?? '')));
    return Response.json({ isolateId, served, secretSha256: [...digest].map((b) => b.toString(16).padStart(2, '0')).join('') });
  },
});
`;

let root = '';
let store: ObjectStore | undefined;
let celld: Running | undefined;
let agent: Running | undefined;
let bundle: SealedBundle;
let agentPort = 0;
let celldPort = 0;
let canary = '';
let bundleId = '';

function startAgent(allowedUid: number, port = agentPort): Running {
  return startKeyAgent(bundle, port, allowedUid);
}

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${celldPort}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe.skipIf(!hasDocker && !process.env.CI)('sealed secrets on celld', () => {
  beforeAll(async () => {
    agentPort = await freePort();
    mkdirSync(LIVE_TMP, { recursive: true });
    root = mkdtempSync(join(LIVE_TMP, 'key-agent-'));
    store = await startObjectStore('sam-live-keyagent', 'live-keyagent-store-0123456789');

    // Seal a canary the way the deploy does (scripts/selfhost/key-service.ts), file provider.
    canary = `live-canary-${randomBytes(16).toString('hex')}`;
    bundle = await sealBundle(join(root, 'state'), { LIVE_SECRET: canary }, 'c'.repeat(32));
    bundleId = bundle.bundleId;
    const project = writeProject(join(root, 'project'), {
      name: 'key-agent-probe',
      worker: WORKER,
      probeObject: true,
      vars: {
        SAM_KEY_AGENT_URL: `http://127.0.0.1:${agentPort}/v1/secrets`,
        SAM_SECRET_BUNDLE_ID: bundleId,
        SAM_KEY_AGENT_VERIFY_KEY: bundle.verifyKey,
        SAM_INSTALLATION_ID: 'c'.repeat(32),
        PLAIN_VAR_CONTROL: 'plain-var-control-value',
      },
    });
    agent = startAgent(process.getuid?.() ?? 0);
    const node = await celldNode(await ensureCelldBinary(join(LIVE_TMP, 'celld-bin')), store);
    celldPort = node.port;
    celld = await node.serve(project);
  }, 300_000);

  afterAll(async () => {
    await celld?.stop();
    await agent?.stop();
    store?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('delivers the secrets to the Worker and to a Durable Object at runtime', async () => {
    const worker = await get('/');
    expect(worker.status).toBe(200);
    expect(worker.body.secretSha256).toBe(sha256(canary));
    const object = await get('/do');
    expect(object).toEqual({ status: 200, body: { doSecret: 'string' } });
  });

  it('leaves no secret in the fleet bucket, while a plain var is stored there in plaintext', () => {
    const copy = join(root, 'bucket-copy');
    mkdirSync(copy);
    if (!store) throw new Error('the object store did not start');
    const mirrored = store.mc(
      ['mirror', '--quiet', 'src/fleet', '/out'],
      ['-u', `${process.getuid?.()}:${process.getgid?.()}`, '-v', `${copy}:/out`]
    );
    expect(mirrored.status, mirrored.stderr).toBe(0);
    const files = filesUnder(copy);
    expect(files.length).toBeGreaterThan(3);
    const contents = files.map((file) => readFileSync(file).toString('latin1'));
    // Control: celld stores deployed vars in plaintext, so a secret var would be here.
    expect(contents.some((text) => text.includes('plain-var-control-value'))).toBe(true);
    for (const form of [canary, Buffer.from(canary).toString('base64')]) {
      expect(contents.filter((text) => text.includes(form))).toEqual([]);
    }
  });

  it('fails closed with 503 while the agent is down, and recovers when it is back', async () => {
    await agent?.stop();
    // Past one 30 s pool tick, so the request lands on a fresh isolate with no cached copy.
    await sleep(40_000);
    const down = await get('/');
    expect(down.status).toBe(503);
    expect(down.body).toMatchObject({
      error: 'SECRETS_UNAVAILABLE',
      code: 'KEY_AGENT_UNREACHABLE',
    });
    expect(JSON.stringify(down.body)).not.toContain(canary);
    agent = startAgent(process.getuid?.() ?? 0);
    await waitFor(
      'the agent',
      async () => (await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => null))?.ok
    );
    const back = await get('/');
    expect(back.status).toBe(200);
    expect(back.body.secretSha256).toBe(sha256(canary));
  }, 90_000);

  it('refuses an impostor that took the agent port while the agent was down', async () => {
    await agent?.stop();
    const impostor: Server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-sam-key-agent-signature': 'AAAA',
      });
      res.end(JSON.stringify({ bundleId, secrets: { LIVE_SECRET: 'forged' } }));
    });
    await new Promise<void>((done) => impostor.listen(agentPort, '127.0.0.1', done));
    try {
      await sleep(40_000); // a fresh isolate, no cached copy
      const res = await get('/');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'KEY_AGENT_UNVERIFIED' });
    } finally {
      await new Promise<void>((done) => impostor.close(() => done()));
      agent = startAgent(process.getuid?.() ?? 0);
      await waitFor(
        'the agent',
        async () => (await fetch(`http://127.0.0.1:${agentPort}/healthz`).catch(() => null))?.ok
      );
    }
    // Control: the real agent's signed answer verifies on celld (Ed25519 WebCrypto).
    expect((await get('/')).body.secretSha256).toBe(sha256(canary));
  }, 90_000);

  it('refuses a caller whose uid it does not allow, on real loopback sockets', async () => {
    const port = await freePort();
    const strict = startAgent((process.getuid?.() ?? 0) + 1, port);
    try {
      await waitFor(
        'strict agent',
        async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok
      );
      const refused = await fetch(`http://127.0.0.1:${port}/v1/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
        body: JSON.stringify({ bundleId }),
      });
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain(canary);
    } finally {
      await strict.stop();
    }
  });
});
