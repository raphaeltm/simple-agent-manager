/**
 * The transit provider against a real OpenBao (pinned image, dev server on loopback): the same
 * conformance suite every provider passes, authenticated the way a box without instance
 * identity would be, with an AppRole whose policy allows encrypt and decrypt on one key and
 * nothing else. Vault speaks the same transit API; OpenBao is used because it runs anywhere.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openBundle, sealSecrets } from '../../../deploy/selfhost/key-agent/bundle.ts';
import { createTransitProvider } from '../../../deploy/selfhost/key-agent/provider-transit.ts';
import { describeKeyProviderConformance } from '../key-provider-conformance';
import { freePort, LIVE_TMP, waitFor } from './harness';

/** quay.io/openbao/openbao:2.4.1 */
export const OPENBAO_IMAGE =
  'quay.io/openbao/openbao@sha256:597f62847dd382382056a1d6704d50465908c2040038c4611832a23269a67112';
const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const ROOT_TOKEN = `live-root-${randomBytes(8).toString('hex')}`;

let port = 0;
let container = '';
let dir = '';
let roleId = '';

async function bao(path: string, body?: unknown, method = 'POST'): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
    method,
    headers: { 'X-Vault-Token': ROOT_TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text}`);
  return text ? (JSON.parse(text) as Record<string, any>) : {};
}

const transit = (key: string, extra: Record<string, string> = {}) =>
  createTransitProvider({
    SAM_TRANSIT_ADDR: `http://127.0.0.1:${port}`,
    SAM_TRANSIT_KEY: key,
    SAM_TRANSIT_ROLE_ID: roleId,
    SAM_TRANSIT_SECRET_ID_FILE: join(dir, 'secret-id'),
    ...extra,
  });

describe.skipIf(!hasDocker && !process.env.CI)('transit provider on OpenBao', () => {
  beforeAll(async () => {
    port = await freePort();
    mkdirSync(LIVE_TMP, { recursive: true });
    dir = mkdtempSync(join(LIVE_TMP, 'openbao-'));
    const run = spawnSync('docker', ['run', '-d', '--rm', '--network', 'host', '-e', `BAO_DEV_ROOT_TOKEN_ID=${ROOT_TOKEN}`, '-e', `BAO_DEV_LISTEN_ADDRESS=127.0.0.1:${port}`, OPENBAO_IMAGE, 'server', '-dev'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    container = run.stdout.trim();
    await waitFor('openbao', async () => (await fetch(`http://127.0.0.1:${port}/v1/sys/health`).catch(() => null))?.ok, 60_000);
    await bao('sys/mounts/transit', { type: 'transit' });
    for (const key of ['sam-box', 'other-box']) await bao(`transit/keys/${key}`);
    // The box's whole authority: encrypt and decrypt with its own key. No read, no export.
    await bao('sys/policies/acl/sam-box', {
      policy: 'path "transit/encrypt/sam-box" { capabilities = ["update"] }\npath "transit/decrypt/sam-box" { capabilities = ["update"] }',
    });
    await bao('sys/auth/approle', { type: 'approle' });
    await bao('auth/approle/role/sam-box', { token_policies: ['sam-box'], token_ttl: '20m', secret_id_ttl: '0' });
    roleId = (await bao('auth/approle/role/sam-box/role-id', undefined, 'GET')).data.role_id as string;
    const secretId = (await bao('auth/approle/role/sam-box/secret-id', {})).data.secret_id as string;
    writeFileSync(join(dir, 'secret-id'), secretId, { mode: 0o600 });
    // A second role that may use only the other key, for the cross-key case.
    await bao('sys/policies/acl/other-box', {
      policy: 'path "transit/encrypt/other-box" { capabilities = ["update"] }\npath "transit/decrypt/other-box" { capabilities = ["update"] }',
    });
  }, 180_000);

  afterAll(() => {
    if (container) spawnSync('docker', ['rm', '-f', container]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describeKeyProviderConformance('transit (OpenBao 2.4.1, AppRole)', {
    provider: () => transit('sam-box'),
    // Root can use the other key; a sam-box blob must still not decrypt there, nor vice versa.
    otherKey: () => {
      writeFileSync(join(dir, 'root-token'), ROOT_TOKEN, { mode: 0o600 });
      return createTransitProvider({ SAM_TRANSIT_ADDR: `http://127.0.0.1:${port}`, SAM_TRANSIT_KEY: 'other-box', SAM_TRANSIT_TOKEN_FILE: join(dir, 'root-token') });
    },
    unreachable: () => createTransitProvider({ SAM_TRANSIT_ADDR: 'http://127.0.0.1:9', SAM_TRANSIT_KEY: 'sam-box', SAM_TRANSIT_TOKEN_FILE: join(dir, 'secret-id') }),
    denied: () => {
      writeFileSync(join(dir, 'bad-token'), 's.not-a-token', { mode: 0o600 });
      return {
        provider: createTransitProvider({ SAM_TRANSIT_ADDR: `http://127.0.0.1:${port}`, SAM_TRANSIT_KEY: 'sam-box', SAM_TRANSIT_TOKEN_FILE: join(dir, 'bad-token') }),
        restore: () => undefined,
      };
    },
    credentials: () => [roleId, ROOT_TOKEN],
  });

  it("the box's AppRole cannot use another install's key, read keys, or export them", async () => {
    const provider = transit('other-box');
    await expect(provider.wrap(new Uint8Array(randomBytes(32)), new Uint8Array(1))).rejects.toMatchObject({ kind: 'denied' });
    const login = await fetch(`http://127.0.0.1:${port}/v1/auth/approle/login`, {
      method: 'POST',
      body: JSON.stringify({ role_id: roleId, secret_id: (await import('node:fs')).readFileSync(join(dir, 'secret-id'), 'utf8') }),
    });
    const token = ((await login.json()) as { auth: { client_token: string } }).auth.client_token;
    for (const path of ['transit/keys/sam-box', 'transit/export/encryption-key/sam-box']) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${path}`, { headers: { 'X-Vault-Token': token } });
      expect(response.status, path).toBe(403);
    }
  });

  it('a KEK rotation (new transit key version) still opens old bundles; a reseal uses the new version', async () => {
    const provider = transit('sam-box');
    const secrets = { ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    const before = await sealSecrets(secrets, provider, { installationId: 'd'.repeat(32) });
    await bao('transit/keys/sam-box/rotate', {});
    expect(await openBundle(before, provider)).toEqual(secrets);
    const after = await sealSecrets(secrets, provider, { installationId: 'd'.repeat(32) });
    expect(Buffer.from(before.wrappedKey, 'base64').toString()).toMatch(/^vault:v1:/);
    expect(Buffer.from(after.wrappedKey, 'base64').toString()).toMatch(/^vault:v2:/);
    expect(await openBundle(after, provider)).toEqual(secrets);
  });
});
