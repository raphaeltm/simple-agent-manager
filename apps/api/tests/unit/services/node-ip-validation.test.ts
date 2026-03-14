/**
 * Tests for IP validation in node provisioning and heartbeat IP backfill.
 *
 * Validates:
 * 1. provisionNode handles empty IP by keeping node in creating state (awaiting heartbeat backfill)
 * 2. Heartbeat handler backfills IP when node has empty ipAddress
 * 3. DNS records are not created with empty IPs
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('provisionNode empty IP guard', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/services/nodes.ts'), 'utf8');
  const section = file.slice(
    file.indexOf('export async function provisionNode'),
    file.indexOf('export async function stopNodeResources')
  );

  it('checks for empty IP before creating DNS records', () => {
    const ipCheckIdx = section.indexOf('if (!vm.ip)');
    const dnsCreateIdx = section.indexOf('createNodeBackendDNSRecord');
    expect(ipCheckIdx).toBeGreaterThan(-1);
    expect(dnsCreateIdx).toBeGreaterThan(-1);
    // IP check must come before DNS record creation
    expect(ipCheckIdx).toBeLessThan(dnsCreateIdx);
  });

  it('keeps node in creating status when IP is empty (awaiting heartbeat backfill)', () => {
    const ipGuardBlock = section.slice(
      section.indexOf('if (!vm.ip)'),
      section.indexOf('let backendDnsRecordId')
    );
    expect(ipGuardBlock).toContain("status: 'creating'");
    expect(ipGuardBlock).toContain('Awaiting IP allocation');
  });

  it('returns early after setting creating status for empty IP', () => {
    const ipGuardBlock = section.slice(
      section.indexOf('if (!vm.ip)'),
      section.indexOf('let backendDnsRecordId')
    );
    expect(ipGuardBlock).toContain('return;');
  });

  it('stores providerInstanceId even when IP is empty (for cleanup)', () => {
    const ipGuardBlock = section.slice(
      section.indexOf('if (!vm.ip)'),
      section.indexOf('let backendDnsRecordId')
    );
    expect(ipGuardBlock).toContain('providerInstanceId: vm.id');
  });

  it('logs structured info with nodeId and providerInstanceId', () => {
    const ipGuardBlock = section.slice(
      section.indexOf('if (!vm.ip)'),
      section.indexOf('let backendDnsRecordId')
    );
    expect(ipGuardBlock).toContain('nodeId: node.id');
    expect(ipGuardBlock).toContain('providerInstanceId: vm.id');
    expect(ipGuardBlock).toContain("action: 'node_awaiting_ip'");
  });
});

describe('heartbeat IP backfill', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
  const heartbeatSection = file.slice(
    file.indexOf("nodesRoutes.post('/:id/heartbeat'"),
    file.indexOf("nodesRoutes.post('/:id/errors'")
  );

  it('checks if node has no IP address stored', () => {
    expect(heartbeatSection).toContain('!node.ipAddress');
  });

  it('extracts IP from CF-Connecting-IP header', () => {
    expect(heartbeatSection).toContain("c.req.header('CF-Connecting-IP')");
  });

  it('only trusts CF-Connecting-IP (not X-Real-IP)', () => {
    expect(heartbeatSection).not.toContain("c.req.header('X-Real-IP')");
  });

  it('transitions creating/error→running when node was awaiting IP allocation', () => {
    expect(heartbeatSection).toContain("node.status === 'creating'");
    expect(heartbeatSection).toContain("node.status === 'error'");
    expect(heartbeatSection).toContain("updatePayload.status = 'running'");
  });

  it('clears errorMessage unconditionally when IP is backfilled (not gated on status)', () => {
    // errorMessage clearing must be OUTSIDE the status condition block
    // to ensure "Awaiting IP allocation" is always cleared when IP arrives
    const ipBackfillBlock = heartbeatSection.slice(
      heartbeatSection.indexOf('updatePayload.ipAddress = heartbeatIp'),
      heartbeatSection.indexOf("node.status === 'creating'")
    );
    expect(ipBackfillBlock).toContain('updatePayload.errorMessage');
  });

  it('updates ipAddress in the database update payload', () => {
    expect(heartbeatSection).toContain('updatePayload.ipAddress = heartbeatIp');
  });

  it('updates existing DNS record when backendDnsRecordId exists', () => {
    expect(heartbeatSection).toContain('updateDNSRecord(node.backendDnsRecordId');
  });

  it('creates new DNS record when no backendDnsRecordId exists', () => {
    expect(heartbeatSection).toContain('createNodeBackendDNSRecord(nodeId, heartbeatIp');
  });

  it('stores new DNS record ID in update payload', () => {
    expect(heartbeatSection).toContain('updatePayload.backendDnsRecordId = dnsRecordId');
  });

  it('logs backfill event with structured context', () => {
    expect(heartbeatSection).toContain('Heartbeat IP backfill');
    expect(heartbeatSection).toContain('backfilledIp');
    expect(heartbeatSection).toContain("action: 'ip_backfilled'");
  });

  it('handles DNS errors gracefully without failing the heartbeat', () => {
    expect(heartbeatSection).toContain('Failed to update DNS during IP backfill');
  });

  it('imports updateDNSRecord and createNodeBackendDNSRecord', () => {
    const imports = file.slice(0, file.indexOf('const nodesRoutes'));
    expect(imports).toContain('updateDNSRecord');
    expect(imports).toContain('createNodeBackendDNSRecord');
  });
});
