/**
 * Tests for IP validation in node provisioning and heartbeat IP backfill.
 *
 * Validates:
 * 1. provisionNode handles empty IP by keeping node in creating state (awaiting heartbeat backfill)
 * 2. Heartbeat handler backfills IP when node has empty ipAddress
 * 3. DNS records are not created with empty IPs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
    expect(ipGuardBlock).toContain("node_provisioning.awaiting_ip_backfill");
  });
});

describe('heartbeat IP backfill', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/node-lifecycle.ts'), 'utf8');
  const heartbeatSection = file.slice(
    file.indexOf("nodeLifecycleRoutes.post('/:id/heartbeat'"),
    file.indexOf("nodeLifecycleRoutes.post('/:id/errors'")
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
    expect(heartbeatSection).toContain('createNodeBackendDNSRecord(nodeId, dnsIp');
  });

  it('stores new DNS record ID in update payload', () => {
    expect(heartbeatSection).toContain('updatePayload.backendDnsRecordId = dnsRecordId');
  });

  it('logs backfill event with structured context', () => {
    expect(heartbeatSection).toContain('heartbeat.ip_backfilled');
    expect(heartbeatSection).toContain('backfilledIp');
    expect(heartbeatSection).toContain("action: 'ip_backfilled'");
  });

  it('handles DNS errors gracefully without failing the heartbeat', () => {
    expect(heartbeatSection).toContain('heartbeat.backend_dns_backfill_failed');
  });

  it('self-heals nodes that already have an IP but no backend DNS record', () => {
    // Behavioral coverage for the tunnel-skip + managed backfill lives in
    // tests/unit/routes/node-lifecycle-byo.test.ts. This structural assertion tracks the
    // effectiveNodeIp initializer, which now short-circuits to null for tunnel-transport nodes.
    expect(heartbeatSection).toContain('let effectiveNodeIp = node.tunnelId ? null : node.ipAddress');
    expect(heartbeatSection).toContain('if (effectiveNodeIp) {');
    expect(heartbeatSection).toContain('const dnsIp = heartbeatIpv4 || effectiveNodeIp');
    expect(heartbeatSection).toContain('} else {');
    expect(heartbeatSection).toContain('createNodeBackendDNSRecord(nodeId, dnsIp');
    expect(heartbeatSection).toContain('updatePayload.backendDnsRecordId = dnsRecordId');
    expect(heartbeatSection).toContain('heartbeat.backend_dns_backfilled');
  });

  it('prefers CF-Connecting-IP over stored IP for backend DNS self-healing', () => {
    const selfHealBlock = heartbeatSection.slice(
      heartbeatSection.indexOf('if (effectiveNodeIp) {'),
      heartbeatSection.indexOf('  await db', heartbeatSection.indexOf('if (effectiveNodeIp) {'))
    );
    expect(selfHealBlock).toContain('const heartbeatIpv4 = isValidIPv4Address(heartbeatIp) ? heartbeatIp : null');
    expect(selfHealBlock).toContain('const dnsIp = heartbeatIpv4 || effectiveNodeIp');
    expect(selfHealBlock).toContain("source: heartbeatIpv4 ? 'heartbeat' : 'stored'");
  });

  it('falls back to stored IP when heartbeat IP is not valid IPv4 for A records', () => {
    const selfHealBlock = heartbeatSection.slice(
      heartbeatSection.indexOf('if (effectiveNodeIp) {'),
      heartbeatSection.indexOf('  await db', heartbeatSection.indexOf('if (effectiveNodeIp) {'))
    );
    expect(file).toContain('function isValidIPv4Address');
    expect(selfHealBlock).toContain('isValidIPv4Address(heartbeatIp)');
    expect(selfHealBlock).toContain('const dnsIp = heartbeatIpv4 || effectiveNodeIp');
  });

  it('clears the DNS-specific provisioning error after backend DNS self-healing succeeds', () => {
    const selfHealBlock = heartbeatSection.slice(
      heartbeatSection.indexOf('if (effectiveNodeIp) {'),
      heartbeatSection.indexOf('  await db', heartbeatSection.indexOf('if (effectiveNodeIp) {'))
    );
    expect(selfHealBlock).toContain('isBackendDnsError(node.errorMessage)');
    expect(selfHealBlock).toContain('updatePayload.errorMessage = sql`NULL`');
    expect(selfHealBlock).toContain("node.status === 'error'");
    expect(selfHealBlock).toContain("updatePayload.status = 'running'");
  });

  it('records and logs backend DNS self-heal failures without failing the heartbeat', () => {
    expect(heartbeatSection).toContain('updatePayload.errorMessage = truncateNodeLifecycleError');
    expect(heartbeatSection).toContain('heartbeat.backend_dns_backfill_failed');
  });

  it('updates existing backend DNS when heartbeat IP changes', () => {
    expect(heartbeatSection).toContain('heartbeatIpv4 && heartbeatIpv4 !== node.ipAddress');
    expect(heartbeatSection).toContain('updateDNSRecord(node.backendDnsRecordId, heartbeatIpv4');
    expect(heartbeatSection).toContain('heartbeat.backend_dns_updated');
  });

  it('imports updateDNSRecord and createNodeBackendDNSRecord', () => {
    const imports = file.slice(0, file.indexOf('const nodeLifecycleRoutes'));
    expect(imports).toContain('updateDNSRecord');
    expect(imports).toContain('createNodeBackendDNSRecord');
  });
});
