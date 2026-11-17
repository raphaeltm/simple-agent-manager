// Register shared boundary mocks before importing production services.
import '../services/node-tunnel-fixture';

import { readFileSync } from 'node:fs';

import { generateCloudInit } from '@simple-agent-manager/cloud-init';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isReverseTunnelSweepCron,
  withReverseTunnel,
} from '../../../src/selfhost/reverse-tunnel/entry';
import { fetchNodeAgent } from '../../../src/services/node-agent';
import { NodeAgentRouteError } from '../../../src/services/node-agent-route';
import { provisionNode } from '../../../src/services/nodes';
import { setOperationalLoopEnabled } from '../../../src/services/operational-kill-switch';
import { probeNodeHealthForTaskLiveness } from '../../../src/services/task-runtime-liveness';
import { applySqliteMigration } from '../../helpers/sqlite-d1';
import {
  env,
  freshNode,
  logged,
  readNode,
  setEnv,
  sqlite,
  tunnelEnv,
} from '../services/node-tunnel-fixture';

/**
 * The self-host entry (`withReverseTunnel`) mounts the lease backstop on the shared sweep cron
 * and routes reverse-tunnel nodes to their lease. Real provisionNode, real lease SQL on the
 * shipped 0255 DDL; only the provider, the shared Worker entry and node HTTP are fakes.
 */
const GATEWAY_SECRET = ['gateway', 'fixture', 'value', 'for', 'entry', 'tests'].join('-');
const SWEEP_CRON = '*/5 * * * *';

const shared = {
  fetch: vi.fn(async () => new Response('shared app')),
  scheduled: vi.fn(async () => undefined),
};
const selfHost = withReverseTunnel(shared, generateCloudInit);
const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const controller = (cron: string) => ({ cron, scheduledTime: Date.now(), noRetry: vi.fn() });

function leaseStatus(nodeId: string): string | undefined {
  const row = sqlite
    .prepare('SELECT status FROM node_reverse_tunnel_leases WHERE node_id = ?')
    .get(nodeId) as { status: string } | undefined;
  return row?.status;
}

async function reverseNode(): Promise<{ id: string; port: number }> {
  const node = await freshNode();
  await provisionNode(node.id, env);
  const row = sqlite
    .prepare('SELECT port FROM node_reverse_tunnel_leases WHERE node_id = ?')
    .get(node.id) as { port: number };
  return { id: node.id, port: row.port };
}

/** A node whose row is gone: exactly what the backstop exists to release. */
async function orphanedLease(): Promise<string> {
  const { id } = await reverseNode();
  sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(id);
  return id;
}

beforeEach(() => {
  applySqliteMigration(
    sqlite,
    new URL('../../../src/selfhost/migrations/0255_node_reverse_tunnel_leases.sql', import.meta.url)
  );
  setEnv(
    tunnelEnv({
      VM_AGENT_TRANSPORT: 'reverse-tunnel',
      REVERSE_TUNNEL_GATEWAY_SECRET: GATEWAY_SECRET,
      ENCRYPTION_KEY: 'test-encryption-key-for-reverse-tunnel-entry',
      CF_API_TOKEN: undefined,
      CF_ACCOUNT_ID: undefined,
      CF_ZONE_ID: undefined,
    })
  );
  shared.scheduled.mockReset().mockResolvedValue(undefined);
  shared.fetch.mockClear();
});

describe('the lease sweep mounted by the self-host entry', () => {
  it('selects exactly the shared five-minute sweep among the deployed cron triggers', () => {
    const toml = readFileSync(new URL('../../../wrangler.toml', import.meta.url), 'utf8');
    const crons = JSON.parse(/^crons = (\[.*\])$/m.exec(toml)?.[1] ?? '[]') as string[];
    expect(crons.length).toBeGreaterThan(1);
    // A new dedicated cron in wrangler.toml must be classified here deliberately.
    expect(crons.filter(isReverseTunnelSweepCron)).toEqual([SWEEP_CRON]);
  });

  it('runs after the shared handler on the sweep cron: releases an orphaned lease, keeps a live one', async () => {
    const orphan = await orphanedLease();
    const live = await reverseNode();
    const order: string[] = [];
    shared.scheduled.mockImplementation(async () => {
      order.push(`shared:${leaseStatus(orphan)}`);
    });
    await selfHost.scheduled(controller(SWEEP_CRON), env, ctx);
    expect(order).toEqual(['shared:active']);
    expect(leaseStatus(orphan)).toBe('released');
    expect(leaseStatus(live.id)).toBe('active');
    expect(
      logged.some(
        (line) => line.includes('cron.reverse_tunnel_lease_sweep') && line.includes('"released":1')
      )
    ).toBe(true);
  });

  it.each(['* * * * *', '0 3 * * *', '30 * * * *'])(
    'does not run on the dedicated cron %s (only the shared handler runs)',
    async (cron) => {
      const orphan = await orphanedLease();
      await selfHost.scheduled(controller(cron), env, ctx);
      expect(shared.scheduled).toHaveBeenCalledTimes(1);
      expect(leaseStatus(orphan)).toBe('active');
    }
  );

  it('still runs when the shared handler throws, and the shared failure still surfaces', async () => {
    const orphan = await orphanedLease();
    shared.scheduled.mockRejectedValue(new Error('shared handler failed'));
    await expect(selfHost.scheduled(controller(SWEEP_CRON), env, ctx)).rejects.toThrow(
      'shared handler failed'
    );
    expect(leaseStatus(orphan)).toBe('released');
  });

  it('honours the operational cron kill switch, logging why it did nothing', async () => {
    const orphan = await orphanedLease();
    await setOperationalLoopEnabled(env, 'cron', false);
    await selfHost.scheduled(controller(SWEEP_CRON), env, ctx);
    expect(leaseStatus(orphan)).toBe('active');
    expect(logged.some((line) => line.includes('"skipReason":"cron_disabled"'))).toBe(true);
    // Control: re-enabled, the same tick releases it.
    await setOperationalLoopEnabled(env, 'cron', true);
    await selfHost.scheduled(controller(SWEEP_CRON), env, ctx);
    expect(leaseStatus(orphan)).toBe('released');
  });

  it('a failing sweep is contained and logged; it never fails the scheduled event', async () => {
    await orphanedLease();
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    prepare.mockImplementation(() => {
      throw new Error('d1 unavailable');
    });
    try {
      await expect(selfHost.scheduled(controller(SWEEP_CRON), env, ctx)).resolves.toBeUndefined();
    } finally {
      prepare.mockRestore();
    }
    expect(logged.some((line) => line.includes('cron.reverse_tunnel_lease_sweep_failed'))).toBe(
      true
    );
  });
});

describe('the self-host entry fetch', () => {
  it('serves the gateway prefix itself and hands every other path to the shared app', async () => {
    const gatewayCall = await selfHost.fetch(
      new Request('http://127.0.0.1:8080/api/self-host/gateway/node-websocket'),
      env,
      ctx
    );
    // Gateway route reached: wrong (missing) secret is 401, and the shared app never saw it.
    expect(gatewayCall.status).toBe(401);
    expect(shared.fetch).not.toHaveBeenCalled();
    for (const path of ['/api/self-host/gatewayx', '/api/nodes', '/health']) {
      expect(
        await (await selfHost.fetch(new Request(`http://api.example${path}`), env, ctx)).text()
      ).toBe('shared app');
    }
    expect(shared.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('reverse-tunnel node routing', () => {
  let nodeFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    nodeFetch = vi.fn(async () => new Response('{"ok":true}'));
    globalThis.fetch = nodeFetch as unknown as typeof fetch;
  });

  const publicUrl = (id: string) =>
    `https://${id.toLowerCase()}.vm.${env.BASE_DOMAIN}:8443/system-info?x=1`;

  it('control-plane requests reach the lease port, and stop on the next request once it is released', async () => {
    const node = await reverseNode();
    expect(readNode(node.id)?.transport).toBe('reverse-tunnel');
    await fetchNodeAgent(node.id, env, publicUrl(node.id), { method: 'GET' }, 1000);
    expect(nodeFetch.mock.calls[0]?.[0]).toBe(`http://127.0.0.1:${node.port}/system-info?x=1`);
    expect((nodeFetch.mock.calls[0]?.[1] as RequestInit).redirect).toBe('manual');

    sqlite
      .prepare("UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?")
      .run(node.id);
    await expect(
      fetchNodeAgent(node.id, env, publicUrl(node.id), { method: 'GET' }, 1000)
    ).rejects.toBeInstanceOf(NodeAgentRouteError);
    expect(nodeFetch).toHaveBeenCalledTimes(1);
  });

  it('a superseded incarnation is never routed to, even while its lease row is still active', async () => {
    const node = await reverseNode();
    sqlite
      .prepare('UPDATE nodes SET runtime_incarnation_id = ? WHERE id = ?')
      .run(crypto.randomUUID(), node.id);
    await expect(
      fetchNodeAgent(node.id, env, publicUrl(node.id), { method: 'GET' }, 1000)
    ).rejects.toBeInstanceOf(NodeAgentRouteError);
    expect(leaseStatus(node.id)).toBe('active');
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it('a lease whose owner no longer matches the node row is never routed to', async () => {
    const node = await reverseNode();
    sqlite
      .prepare("UPDATE node_reverse_tunnel_leases SET user_id = 'someone-else' WHERE node_id = ?")
      .run(node.id);
    await expect(
      fetchNodeAgent(node.id, env, publicUrl(node.id), { method: 'GET' }, 1000)
    ).rejects.toBeInstanceOf(NodeAgentRouteError);
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it('the liveness probe uses the lease route; a missing lease is inconclusive, never "failed"', async () => {
    const node = await reverseNode();
    const ok = await probeNodeHealthForTaskLiveness(env, node.id, 'reverse-tunnel');
    expect(ok).toMatchObject({ outcome: 'ok', url: `http://127.0.0.1:${node.port}/health` });

    sqlite
      .prepare("UPDATE node_reverse_tunnel_leases SET status = 'released' WHERE node_id = ?")
      .run(node.id);
    const gone = await probeNodeHealthForTaskLiveness(env, node.id, 'reverse-tunnel');
    expect(gone.outcome).toBe('error');
    expect(nodeFetch).toHaveBeenCalledTimes(1);
  });

  it('control: a public-transport probe makes its one public fetch and no D1 read', async () => {
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    for (const transport of [null, 'vm-public-dns', 'cloudflare-tunnel']) {
      const result = await probeNodeHealthForTaskLiveness(env, 'NODEPUBLIC', transport);
      expect(result.url).toBe(`https://nodepublic.vm.${env.BASE_DOMAIN}:8443/health`);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(nodeFetch).toHaveBeenCalledTimes(3);
  });
});
