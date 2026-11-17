import './node-tunnel-fixture';

import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import { beforeEach, describe, expect, it } from 'vitest';

import { authorizeFrpsPluginRequest } from '../../../src/selfhost/reverse-tunnel/authz';
import { deriveReverseTunnelCredential, deriveReverseTunnelRunId } from '../../../src/selfhost/reverse-tunnel/config';
import { installReverseTunnelTransport } from '../../../src/selfhost/reverse-tunnel/transport';
import { provisionNode } from '../../../src/services/nodes';
import { applySqliteMigration } from '../../helpers/sqlite-d1';
import { env, freshNode, mocks, readNode, setEnv, sqlite, tunnelEnv } from './node-tunnel-fixture';

beforeEach(() => {
  applySqliteMigration(sqlite, new URL('../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql', import.meta.url));
  installReverseTunnelTransport(generateCloudInit);
  setEnv(tunnelEnv({ VM_AGENT_TRANSPORT: 'reverse-tunnel',
    REVERSE_TUNNEL_GATEWAY_SECRET: ['test', 'gateway', 'secret', 'long', 'enough', 'here'].join('-'),
    ENCRYPTION_KEY: 'fixture-key-for-derived-credentials' }));
});
async function owner() {
  const node = await freshNode(); await provisionNode(node.id, env);
  const incarnation = readNode(node.id)!.incarnation!;
  const lease = sqlite.prepare('SELECT id, port FROM node_reverse_tunnel_leases WHERE node_id=?').get(node.id) as { id: string; port: number };
  const credential = mocks.cloudInitVars.at(-1)!.reverseTunnelCredential as string;
  return { node, incarnation, lease, credential,
    metas: { node_id: node.id, incarnation, credential } };
}
async function login(value: Awaited<ReturnType<typeof owner>>, chosenRunId = '') {
  const content = { user: value.node.id, metas: value.metas, run_id: chosenRunId, version: '0.72.0', os: 'linux' };
  const result = await authorizeFrpsPluginRequest(env, 'Login', { content });
  expect(result.allow).toBe(true);
  if (!result.allow) throw new Error('Login refused');
  expect(result.replacementContent).toMatchObject({ ...content, run_id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  return result.replacementContent!.run_id as string;
}
function call(op: string, content: unknown) { return authorizeFrpsPluginRequest(env, op, { content }); }

describe('frps authorization at the SQL ownership boundary', () => {
  it('canonicalizes simultaneous duplicate logins and preserves the frp Login fields', async () => {
    const a = await owner();
    const runIds = await Promise.all([login(a, 'client-selected-one'), login(a, 'another-session')]);
    expect(runIds[0]).toBe(runIds[1]);
    const b = await owner(); expect(await login(b)).not.toBe(runIds[0]);
  });
  it('allows the owner proxy, heartbeat and work connection in the canonical session', async () => {
    const a = await owner(); const runId = await login(a);
    const user = { user: a.node.id, metas: a.metas, run_id: runId };
    expect(await call('NewProxy', { user, proxy_name: `${a.node.id}.sam-agent`, proxy_type: 'tcp', remote_port: a.lease.port })).toEqual({ allow: true });
    expect(await call('Ping', { user })).toEqual({ allow: true });
    expect(await call('NewWorkConn', { user, run_id: runId })).toEqual({ allow: true });
  });
  it.each(['NewProxy', 'Ping', 'NewWorkConn'])('refuses a noncanonical session on %s', async (op) => {
    const a = await owner(); await login(a);
    const user = { user: a.node.id, metas: a.metas, run_id: 'another-control' };
    expect(await call(op, { user, run_id: user.run_id, proxy_name: `${a.node.id}.sam-agent`, proxy_type: 'tcp', remote_port: a.lease.port })).toMatchObject({ allow: false, code: 'session_mismatch' });
  });
  it('refuses mismatched outer work-connection run_id and malformed or unsupported requests', async () => {
    const a = await owner(); const runId = await login(a);
    expect(await call('NewWorkConn', { user: { user: a.node.id, metas: a.metas, run_id: runId }, run_id: 'other' })).toMatchObject({ allow: false, code: 'run_id_mismatch' });
    expect(await call('Login', {})).toMatchObject({ allow: false, code: 'malformed' });
    expect(await call('CloseProxy', {})).toMatchObject({ allow: false, code: 'unsupported_op' });
  });
  it('refuses another node credential even with the victim real node and incarnation', async () => {
    const a = await owner(); const b = await owner();
    expect(await call('Login', { user: b.node.id, metas: { ...b.metas, credential: a.credential } })).toMatchObject({ allow: false, code: 'bad_credential' });
    expect(await call('Login', { user: b.node.id, metas: a.metas })).toMatchObject({ allow: false, code: 'identity_mismatch' });
    expect(await call('Login', { user: a.node.id, metas: { ...a.metas, incarnation: b.incarnation } })).toMatchObject({ allow: false });
    await login(a); await login(b);
  });
  it.each([
    ["UPDATE node_reverse_tunnel_leases SET status='released'", 'lease_released'],
    ["UPDATE nodes SET status='destroying'", 'node_not_live'],
    ["UPDATE nodes SET status='stopped'", 'node_not_live'],
    ["UPDATE nodes SET status='deleted'", 'node_not_live'],
    ["UPDATE nodes SET runtime_termination_confirmed_at='proof'", 'node_not_live'],
    ["UPDATE nodes SET runtime_incarnation_id='superseded'", 'node_not_live'],
    ["UPDATE nodes SET node_class='user-owned'", 'node_not_live'],
    ["UPDATE nodes SET runtime='cf-container'", 'node_not_live'],
    ["UPDATE nodes SET transport='cloudflare-tunnel'", 'node_not_live'],
    ["UPDATE nodes SET user_id='foreign-user'", 'node_not_live'],
  ])('refuses revoked authority: %s', async (sql, code) => {
    const a = await owner(); const runId = await login(a); sqlite.exec(sql);
    expect(await call('Login', { user: a.node.id, metas: a.metas })).toMatchObject({ allow: false, code });
    for (const op of ['Ping', 'NewProxy', 'NewWorkConn']) {
      expect(await call(op, { user: { user: a.node.id, metas: a.metas, run_id: runId }, run_id: runId, proxy_name: `${a.node.id}.sam-agent`, proxy_type: 'tcp', remote_port: a.lease.port })).toMatchObject({ allow: false, code });
    }
  });
  it.each([
    [{ proxy_type: 'http' }, 'proxy_type'],
    [{ proxy_name: 'other.sam-agent' }, 'proxy_name'],
    [{ remote_port: 1 }, 'port_not_leased'],
  ])('refuses an unleased proxy: %j', async (patch, code) => {
    const a = await owner(); const runId = await login(a);
    expect(await call('NewProxy', { user: { user: a.node.id, metas: a.metas, run_id: runId }, proxy_name: `${a.node.id}.sam-agent`, proxy_type: 'tcp', remote_port: a.lease.port, ...patch })).toMatchObject({ allow: false, code });
  });
});

describe('purpose subkeys', () => {
  it('matches an independently constructed HKDF then HMAC vector', async () => {
    const input = { leaseId: 'lease', nodeId: 'node', runtimeIncarnationId: 'incarnation' };
    const enc = new TextEncoder();
    const root = await crypto.subtle.importKey('raw', enc.encode(env.ENCRYPTION_KEY), 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('sam:reverse-tunnel:v1'), info: enc.encode('sam-reverse-tunnel-credential:v1') }, root, 256);
    const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signed = await crypto.subtle.sign('HMAC', key, enc.encode(JSON.stringify(['lease', 'node', 'incarnation'])));
    const expected = Buffer.from(signed).toString('base64url');
    expect(await deriveReverseTunnelCredential(env, input)).toBe(expected);
    expect(await deriveReverseTunnelRunId(env, input)).not.toBe(expected.slice(0, 32));
    for (const field of ['leaseId', 'nodeId', 'runtimeIncarnationId'] as const) {
      expect(await deriveReverseTunnelCredential(env, { ...input, [field]: 'other' })).not.toBe(expected);
    }
    expect(await deriveReverseTunnelCredential({ ENCRYPTION_KEY: 'rotated' }, input)).not.toBe(expected);
  });
});
