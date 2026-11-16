/** IP and DNS reconciliation for the authenticated node heartbeat. */
import { sql } from 'drizzle-orm';
import type { Context } from 'hono';

import type { Node } from '../db/schema';
import type { Env } from '../env';
import { clientIpFromHeaders } from '../lib/client-ip';
import { log } from '../lib/logger';
import { createNodeBackendDNSRecord, updateDNSRecord } from '../services/dns';

const NODE_DNS_ERROR_MESSAGE_MAX_LENGTH = 500;
const NODE_BACKEND_DNS_ERROR_PREFIX = 'Backend DNS record creation failed:';

function truncateNodeLifecycleError(value: string): string {
  return value.length > NODE_DNS_ERROR_MESSAGE_MAX_LENGTH
    ? `${value.slice(0, NODE_DNS_ERROR_MESSAGE_MAX_LENGTH - 3)}...`
    : value;
}

function isBackendDnsError(errorMessage: string | null | undefined): boolean {
  return !!errorMessage && errorMessage.startsWith(NODE_BACKEND_DNS_ERROR_PREFIX);
}

function isValidIPv4Address(value: string | null | undefined): value is string {
  if (!value) return false;

  const octets = value.split('.');
  if (octets.length !== 4) return false;

  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) return false;
    const numeric = Number(octet);
    return numeric >= 0 && numeric <= 255;
  });
}

type HeartbeatIpParams = {
  c: Context<{ Bindings: Env }>;
  node: Node;
  nodeId: string;
  updatePayload: Record<string, unknown>;
};

function selectHeartbeatIp(
  node: Node,
  nodeId: string,
  connectingIp: string | undefined
): string | undefined {
  // Tunnel-transport nodes are reached via a proxied CNAME → cloudflared, NOT a public-IP A record,
  // and their CF-Connecting-IP is the tunnel/NAT egress. Suppress ALL IP/A-record backfill for them
  // server-side (keyed on tunnelId presence, NOT nodeClass — a future public-IP BYO mode still wants
  // backfill) so a heartbeat can never create an A record that conflicts with the enrollment CNAME.
  // See security-critique #8 / architecture-critique #7.
  // One exception: a deployment-role tunnel node whose provider reported no IP at create. Its
  // app routes are grey-cloud A records to the node's public IP (services/dns-app-routes.ts),
  // so it records the heartbeat's IPv4 egress as `ip_address` only. It never gets a backend A
  // record: `effectiveNodeIp` stays null for every tunnel node.
  const deploymentTunnelIpBackfill =
    !!node.tunnelId &&
    node.nodeRole === 'deployment' &&
    node.nodeClass === 'managed' &&
    !node.ipAddress;
  if (node.tunnelId && !deploymentTunnelIpBackfill) {
    log.debug('heartbeat.ip_backfill_skipped_tunnel_node', { nodeId, action: 'skipped' });
  }
  if (!node.tunnelId || (deploymentTunnelIpBackfill && isValidIPv4Address(connectingIp))) {
    return connectingIp;
  }
  return undefined;
}

function backfillNodeIp(
  node: Node,
  nodeId: string,
  heartbeatIp: string | undefined,
  updatePayload: Record<string, unknown>
): void {
  if (node.ipAddress || !heartbeatIp) return;
  log.info('heartbeat.ip_backfilled', {
    nodeId,
    backfilledIp: heartbeatIp,
    action: 'ip_backfilled',
  });
  updatePayload.ipAddress = heartbeatIp;
  // Explicit SQL NULL is required: an undefined property is dropped by Drizzle/D1.
  updatePayload.errorMessage = sql`NULL`;
  if (node.status === 'creating' || node.status === 'error') updatePayload.status = 'running';
}

async function reconcileHeartbeatDns(
  params: HeartbeatIpParams,
  heartbeatIp: string | undefined,
  effectiveNodeIp: string
): Promise<void> {
  const { c, node, nodeId, updatePayload } = params;
  const heartbeatIpv4 = isValidIPv4Address(heartbeatIp) ? heartbeatIp : null;
  const dnsIp = heartbeatIpv4 || effectiveNodeIp;
  try {
    if (node.backendDnsRecordId) {
      if (heartbeatIpv4 && heartbeatIpv4 !== node.ipAddress) {
        await updateDNSRecord(node.backendDnsRecordId, heartbeatIpv4, c.env);
        log.info('heartbeat.backend_dns_updated', {
          nodeId,
          ipAddress: heartbeatIpv4,
          previousIpAddress: node.ipAddress,
        });
      }
      return;
    }
    const dnsRecordId = await createNodeBackendDNSRecord(nodeId, dnsIp, c.env);
    updatePayload.backendDnsRecordId = dnsRecordId;
    if (isBackendDnsError(node.errorMessage)) {
      updatePayload.errorMessage = sql`NULL`;
      if (node.status === 'error') {
        updatePayload.status = 'running';
      }
    }
    log.info('heartbeat.backend_dns_backfilled', {
      nodeId,
      ipAddress: dnsIp,
      source: heartbeatIpv4 ? 'heartbeat' : 'stored',
    });
  } catch (dnsErr) {
    const message = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
    updatePayload.errorMessage = truncateNodeLifecycleError(
      `${NODE_BACKEND_DNS_ERROR_PREFIX} ${message}`
    );
    log.error('heartbeat.backend_dns_backfill_failed', {
      nodeId,
      ipAddress: dnsIp,
      hasExistingDnsRecord: !!node.backendDnsRecordId,
      error: String(dnsErr),
    });
  }
}

export async function applyHeartbeatIp(params: HeartbeatIpParams): Promise<void> {
  const { c, node, nodeId, updatePayload } = params;
  // Also heal an old awaiting-IP error when the address was backfilled on a prior heartbeat.
  if (node.ipAddress && node.errorMessage?.includes('Awaiting IP allocation')) {
    updatePayload.errorMessage = sql`NULL`;
  }
  const connectingIp = clientIpFromHeaders((name) => c.req.header(name)) ?? undefined;
  const heartbeatIp = selectHeartbeatIp(node, nodeId, connectingIp);
  backfillNodeIp(node, nodeId, heartbeatIp, updatePayload);
  // A tunnel's app-route IP may be recorded, but its CNAME must never get a backend A record.
  const effectiveNodeIp = node.tunnelId ? null : node.ipAddress || heartbeatIp;
  if (effectiveNodeIp) await reconcileHeartbeatDns(params, heartbeatIp, effectiveNodeIp);
}
