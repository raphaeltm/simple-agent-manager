/** Behavioral coverage for heartbeat IP/DNS reconciliation; route wiring is covered by node-lifecycle-byo. */
import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Node } from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { applyHeartbeatIp } from '../../../src/routes/node-heartbeat-ip';
import { createNodeBackendDNSRecord, updateDNSRecord } from '../../../src/services/dns';

vi.mock('../../../src/services/dns', () => ({
  createNodeBackendDNSRecord: vi.fn(),
  updateDNSRecord: vi.fn(),
}));

const REAL_IP = '203.0.113.7';
const STORED_IP = '203.0.113.8';
const env = { BASE_DOMAIN: 'example.com' } as Env;

async function heartbeat(
  overrides: Partial<Node> = {},
  headers: Record<string, string> = { 'CF-Connecting-IP': REAL_IP }
) {
  const node = {
    id: 'node-1',
    status: 'running',
    nodeClass: 'managed',
    nodeRole: 'workspace',
    ipAddress: null,
    backendDnsRecordId: null,
    errorMessage: null,
    tunnelId: null,
    ...overrides,
  } as Node;
  const requestHeaders = new Headers(headers);
  const c = {
    env,
    req: { header: (name: string) => requestHeaders.get(name) ?? undefined },
  } as Context<{ Bindings: Env }>;
  const updatePayload: Record<string, unknown> = {};
  await applyHeartbeatIp({ c, node, nodeId: node.id, updatePayload });
  return updatePayload;
}

describe('heartbeat IP backfill', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(createNodeBackendDNSRecord).mockResolvedValue('dns-record-id');
    vi.mocked(updateDNSRecord).mockResolvedValue(undefined);
  });

  it.each(['creating', 'error', 'running'] as const)(
    'backfills and clears the awaiting-IP error for %s nodes',
    async (status) => {
      const result = await heartbeat({ status, errorMessage: 'Awaiting IP allocation' });
      expect(result).toMatchObject({ ipAddress: REAL_IP, backendDnsRecordId: 'dns-record-id' });
      expect(result.errorMessage).toBeDefined(); // explicit SQL NULL, never undefined/dropped
      if (status === 'running') expect(result).not.toHaveProperty('status');
      else expect(result.status).toBe('running');
      expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', REAL_IP, env);
    }
  );

  it.each([
    {},
    { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2' },
    { 'CF-Connecting-IP': '999.1.1.1' },
  ])('does not backfill or create DNS without a valid ingress IP: %j', async (headers) => {
    expect(await heartbeat({}, headers)).toEqual({});
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it('prefers ingress IPv4 over stored IPv4 and ignores spoofed XFF', async () => {
    const result = await heartbeat(
      { ipAddress: STORED_IP },
      { 'CF-Connecting-IP': REAL_IP, 'X-Forwarded-For': '198.51.100.1' }
    );
    expect(result).toEqual({ backendDnsRecordId: 'dns-record-id' });
    expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', REAL_IP, env);
  });

  it.each([{}, { 'CF-Connecting-IP': '2001:db8::7' }])(
    'uses stored IP for missing or IPv6 heartbeat IP: %j',
    async (headers) => {
      expect(await heartbeat({ ipAddress: STORED_IP }, headers)).toEqual({
        backendDnsRecordId: 'dns-record-id',
      });
      expect(createNodeBackendDNSRecord).toHaveBeenCalledWith('node-1', STORED_IP, env);
    }
  );

  it('updates existing DNS when ingress IPv4 changes', async () => {
    expect(await heartbeat({ ipAddress: STORED_IP, backendDnsRecordId: 'existing-dns' })).toEqual(
      {}
    );
    expect(updateDNSRecord).toHaveBeenCalledWith('existing-dns', REAL_IP, env);
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
  });

  it('keeps existing DNS when the IP has not changed', async () => {
    expect(await heartbeat({ ipAddress: REAL_IP, backendDnsRecordId: 'existing-dns' })).toEqual({});
    expect(updateDNSRecord).not.toHaveBeenCalled();
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
  });

  it('clears the provisioning DNS error after self-healing succeeds', async () => {
    const result = await heartbeat({
      ipAddress: STORED_IP,
      status: 'error',
      errorMessage: 'Backend DNS record creation failed: provider error',
    });
    expect(result).toMatchObject({ status: 'running', backendDnsRecordId: 'dns-record-id' });
    expect(result.errorMessage).toBeDefined();
  });

  it('records bounded DNS failure without failing the heartbeat', async () => {
    vi.mocked(createNodeBackendDNSRecord).mockRejectedValue(new Error('x'.repeat(600)));
    const result = await heartbeat();
    expect(result.ipAddress).toBe(REAL_IP);
    expect(result.errorMessage).toEqual(
      expect.stringContaining('Backend DNS record creation failed:')
    );
    expect(String(result.errorMessage)).toHaveLength(500);
    expect(result).not.toHaveProperty('backendDnsRecordId');
  });

  it('skips IP and DNS for tunnel workspace nodes', async () => {
    expect(await heartbeat({ tunnelId: 'tunnel-1' })).toEqual({});
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });

  it('records deployment tunnel IPv4 without creating conflicting backend DNS', async () => {
    expect(await heartbeat({ tunnelId: 'tunnel-1', nodeRole: 'deployment' })).toHaveProperty(
      'ipAddress',
      REAL_IP
    );
    expect(createNodeBackendDNSRecord).not.toHaveBeenCalled();
    expect(updateDNSRecord).not.toHaveBeenCalled();
  });
});
