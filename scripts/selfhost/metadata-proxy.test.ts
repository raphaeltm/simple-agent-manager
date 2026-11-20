import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { metadataServer, NATIVE_TOKEN_QUERY } from '../../deploy/selfhost/metadata-proxy/server.ts';
import {
  accessBoundary,
  METADATA_TOKEN_PATH,
  STORAGE_SCOPE_PREFIX,
  tokenSource,
} from '../../deploy/selfhost/metadata-proxy/token.ts';

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
});
const config = {
  bucket: 'fleet-bucket',
  scope: `${STORAGE_SCOPE_PREFIX}read_write`,
  timeoutMs: 250,
  maxResponseBytes: 4096,
};
const secret = 'a'.repeat(64);

describe('fixed-bucket metadata CAB broker', () => {
  it('runs the official STS exchange, caches the scoped token and refuses caller scope/resource overrides', async () => {
    const seen: URLSearchParams[] = [];
    let metadataHits = 0;
    const metadata = await listen(
      createServer((req, res) => {
        metadataHits++;
        expect(req.headers['metadata-flavor']).toBe('Google');
        res.end(
          JSON.stringify({ access_token: 'fake-source', expires_in: 3600, token_type: 'Bearer' })
        );
      })
    );
    const sts = await listen(
      createServer(async (req, res) => {
        let raw = '';
        for await (const b of req) raw += b;
        const fields = new URLSearchParams(raw);
        seen.push(fields);
        const options = JSON.parse(fields.get('options') ?? '{}');
        if (
          options.accessBoundary?.accessBoundaryRules?.[0]?.availableResource !==
          '//storage.googleapis.com/projects/_/buckets/fleet-bucket'
        ) {
          res.writeHead(403).end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            access_token: 'fake-downscoped',
            expires_in: 1800,
            token_type: 'Bearer',
          })
        );
      })
    );
    const issue = tokenSource(config, { metadata, sts });
    const proxy = await listen(metadataServer(secret, issue, process.getuid!()));
    const url = `${proxy}/${secret}${METADATA_TOKEN_PATH}`;
    const ask = (target: string) => fetch(target, { headers: { 'Metadata-Flavor': 'Google' } });
    const response = await ask(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      access_token: 'fake-downscoped',
      token_type: 'Bearer',
    });
    expect(await (await ask(url)).json()).toMatchObject({ access_token: 'fake-downscoped' });
    expect((await ask(url + NATIVE_TOKEN_QUERY)).status).toBe(200);
    expect(metadataHits).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get('subject_token')).toBe('fake-source');
    expect(JSON.parse(seen[0]!.get('options')!)).toEqual(accessBoundary(config));
    for (const suffix of [
      '?scopes=https://www.googleapis.com/auth/cloud-platform',
      '?bucket=another-bucket',
      '?recursive=true',
      '?audience=other',
      NATIVE_TOKEN_QUERY + '&scopes=https://www.googleapis.com/auth/cloud-platform',
      NATIVE_TOKEN_QUERY + '&' + NATIVE_TOKEN_QUERY.slice(1),
      '?audience=https://www.googleapis.com/oauth2/v4/token',
      '/identity',
    ]) {
      expect((await ask(url + suffix)).status).toBe(404);
    }
    expect((await ask(`${proxy}${METADATA_TOKEN_PATH}`)).status).toBe(404);
    expect((await fetch(url)).status).toBe(404);
    expect(
      (await fetch(url, { method: 'POST', headers: { 'Metadata-Flavor': 'Google' } })).status
    ).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it('refuses another host uid even with the correct secret path', async () => {
    let minted = false;
    const proxy = await listen(
      metadataServer(
        secret,
        async () => {
          minted = true;
          return { access_token: 'fake', expires_in: 300, token_type: 'Bearer' };
        },
        process.getuid!() + 1
      )
    );
    const response = await fetch(`${proxy}/${secret}${METADATA_TOKEN_PATH}`, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    expect(response.status).toBe(403);
    expect(minted).toBe(false);
  });

  it('narrows read_only and rejects full_control, mixed scopes and resource injection', () => {
    expect(
      accessBoundary({ ...config, scope: `${STORAGE_SCOPE_PREFIX}read_only` }).accessBoundary
        .accessBoundaryRules[0]!.availablePermissions
    ).toEqual(['inRole:roles/storage.objectViewer']);
    for (const scope of [
      `${STORAGE_SCOPE_PREFIX}full_control`,
      'constructor',
      '__proto__',
      'https://www.googleapis.com/auth/cloud-platform',
      `${config.scope},${config.scope}`,
    ]) {
      expect(() => accessBoundary({ ...config, scope })).toThrow();
    }
    for (const bucket of ['', 'a/../../other', 'fleet?bucket=other', '*', 'a..b']) {
      expect(() => accessBoundary({ ...config, bucket })).toThrow();
    }
  });

  it.each(
    (['metadata', 'sts'] as const).flatMap((upstream) =>
      [307, 308].map((status) => ({ upstream, status }))
    )
  )(
    'refuses $upstream HTTP $status without contacting the redirect sink',
    async ({ upstream, status }) => {
      let sinkHits = 0;
      let metadataHits = 0;
      let stsHits = 0;
      const scoped = {
        access_token: 'fake-scoped-control',
        expires_in: 1800,
        token_type: 'Bearer',
      };
      const source = {
        access_token: 'fake-source-control',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const sink = await listen(
        createServer((_req, res) => {
          sinkHits++;
          res.setHeader('Content-Type', 'application/json');
          // Both redirected upstream paths would otherwise end in a usable scoped response.
          res.end(JSON.stringify(upstream === 'metadata' ? source : scoped));
        })
      );
      const metadata = await listen(
        createServer((_req, res) => {
          metadataHits++;
          if (upstream === 'metadata') {
            res.writeHead(status, { Location: sink }).end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(source));
        })
      );
      const sts = await listen(
        createServer((_req, res) => {
          stsHits++;
          if (upstream === 'sts') {
            res.writeHead(status, { Location: sink }).end();
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(scoped));
        })
      );
      const proxy = await listen(
        metadataServer(secret, tokenSource(config, { metadata, sts }), process.getuid!())
      );
      const response = await fetch(`${proxy}/${secret}${METADATA_TOKEN_PATH}`, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      expect(metadataHits).toBe(1);
      if (upstream === 'metadata') expect(stsHits).toBe(0);
      else expect(stsHits).toBeGreaterThan(0);
      expect(sinkHits).toBe(0);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Scoped token unavailable');
    }
  );

  it.each(['metadata', 'sts'] as const)(
    'bounds a valid chunked oversized %s token response',
    async (upstream) => {
      let metadataHits = 0;
      let stsHits = 0;
      const source = {
        access_token: 'fake-source-control',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const scoped = {
        access_token: 'fake-scoped-control',
        expires_in: 1800,
        token_type: 'Bearer',
      };
      const send = (
        res: import('node:http').ServerResponse,
        value: typeof source,
        oversized: boolean
      ) => {
        const body = JSON.stringify(
          oversized
            ? { ...value, access_token: 'fake-' + 'x'.repeat(config.maxResponseBytes * 2) }
            : value
        );
        res.setHeader('Content-Type', 'application/json');
        // write() forces chunked transfer, so a Content-Length check cannot satisfy this test.
        res.write(body.slice(0, Math.floor(body.length / 2)));
        res.end(body.slice(Math.floor(body.length / 2)));
      };
      const metadata = await listen(
        createServer((_req, res) => {
          metadataHits++;
          send(res, source, upstream === 'metadata');
        })
      );
      const sts = await listen(
        createServer((_req, res) => {
          stsHits++;
          send(res, scoped, upstream === 'sts');
        })
      );
      const proxy = await listen(
        metadataServer(secret, tokenSource(config, { metadata, sts }), process.getuid!())
      );
      const response = await fetch(`${proxy}/${secret}${METADATA_TOKEN_PATH}`, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      expect(metadataHits).toBe(1);
      if (upstream === 'metadata') expect(stsHits).toBe(0);
      else expect(stsHits).toBeGreaterThan(0);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Scoped token unavailable');
    }
  );

  it.each(['failure', 'redirect', 'malformed', 'source-token', 'oversize', 'timeout'])(
    'never falls back to the VM token on %s',
    async (mode) => {
      const source = {
        access_token: 'fake-sensitive-source',
        expires_in: 3600,
        token_type: 'Bearer',
      };
      const metadata = await listen(createServer((_req, res) => res.end(JSON.stringify(source))));
      const sts = await listen(
        createServer((_req, res) => {
          if (mode === 'timeout') return;
          if (mode === 'redirect') {
            res.writeHead(302, { Location: metadata }).end();
            return;
          }
          if (mode === 'failure') {
            res.writeHead(403).end(JSON.stringify(source));
            return;
          }
          if (mode === 'oversize') {
            res.end('x'.repeat(8192));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(mode === 'source-token' ? JSON.stringify(source) : '{}');
        })
      );
      const proxy = await listen(
        metadataServer(secret, tokenSource(config, { metadata, sts }), process.getuid!())
      );
      const response = await fetch(`${proxy}/${secret}${METADATA_TOKEN_PATH}`, {
        headers: { 'Metadata-Flavor': 'Google' },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Scoped token unavailable');
    }
  );
});
