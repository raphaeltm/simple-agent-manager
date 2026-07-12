import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  createDNSRecord,
  createNodeBackendDNSRecord,
  cleanupWorkspaceDNSRecords,
  getBackendHostname,
  getNodeBackendHostname,
  getWorkspaceUrl,
} from '../../../src/services/dns';

const nestedDomainEnv = {
  BASE_DOMAIN: 'dev-a.example.com',
  CF_API_TOKEN: 'cf-token',
  CF_ZONE_ID: 'zone-id',
} as Env;

describe('DNS hostname construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getNodeBackendHostname', () => {
    it('returns two-level subdomain format ({nodeId}.vm.{domain})', () => {
      expect(getNodeBackendHostname('node-abc', 'example.com')).toBe('node-abc.vm.example.com');
    });

    it('lowercases the nodeId', () => {
      expect(getNodeBackendHostname('NODE-ABC', 'example.com')).toBe('node-abc.vm.example.com');
    });

    it('does NOT use vm- prefix (legacy format)', () => {
      const hostname = getNodeBackendHostname('node-abc', 'example.com');
      expect(hostname).not.toContain('vm-');
      expect(hostname).toContain('.vm.');
    });

    it('produces a hostname that does NOT match *.{domain} wildcard (2 subdomain levels)', () => {
      const hostname = getNodeBackendHostname('node-abc', 'example.com');
      // *.example.com matches exactly one subdomain level
      // node-abc.vm.example.com has two levels — does NOT match
      const parts = hostname.replace('.example.com', '').split('.');
      expect(parts.length).toBe(2); // node-abc.vm = 2 levels
    });
  });

  describe('getBackendHostname', () => {
    it('delegates to getNodeBackendHostname', () => {
      expect(getBackendHostname('ws-123', 'example.com')).toBe(
        getNodeBackendHostname('ws-123', 'example.com')
      );
    });
  });

  describe('getWorkspaceUrl', () => {
    it('returns single-level subdomain (ws-{id}.{domain})', () => {
      expect(getWorkspaceUrl('abc123', 'example.com')).toBe('https://ws-abc123.example.com');
    });
  });

  it('creates a fully qualified workspace record under a nested deployment domain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { id: 'workspace-record-id' } }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(createDNSRecord('WORKSPACE-1', '203.0.113.10', nestedDomainEnv)).resolves.toBe(
      'workspace-record-id'
    );

    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: 'ws-WORKSPACE-1.dev-a.example.com',
    });
  });

  it('creates a fully qualified VM backend record under a nested deployment domain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { id: 'backend-record-id' } }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createNodeBackendDNSRecord('NODE-1', '203.0.113.11', nestedDomainEnv)
    ).resolves.toBe('backend-record-id');

    const [, request] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(request.body))).toMatchObject({
      name: 'node-1.vm.dev-a.example.com',
    });
  });

  it('cleans up canonical nested workspace and VM hostnames plus the legacy backend name', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(cleanupWorkspaceDNSRecords('WORKSPACE-1', nestedDomainEnv)).resolves.toBe(0);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records?name=ws-workspace-1.dev-a.example.com',
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records?name=vm-workspace-1.dev-a.example.com',
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records?name=workspace-1.vm.dev-a.example.com',
    ]);
  });
});
