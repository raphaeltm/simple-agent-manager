import type { Env } from '../index';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * DNS Record interface
 */
export interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/**
 * DNS Service interface for dependency injection
 */
export interface DNSServiceInterface {
  createRecord(workspaceId: string, ip: string, baseDomain: string): Promise<DNSRecord>;
  deleteRecord(workspaceId: string, baseDomain: string): Promise<boolean>;
  findRecord(workspaceId: string, baseDomain: string): Promise<DNSRecord | null>;
  recordExists(workspaceId: string, baseDomain: string): Promise<boolean>;
}

/**
 * Cloudflare DNS Service implementation
 */
export class DNSService implements DNSServiceInterface {
  constructor(private env: Env) {}

  async createRecord(workspaceId: string, ip: string, _baseDomain: string): Promise<DNSRecord> {
    const id = await createDNSRecord(workspaceId, ip, this.env);
    return {
      id,
      name: `ws-${workspaceId}`,
      type: 'A',
      content: ip,
      proxied: true,
      ttl: 60,
    };
  }

  async deleteRecord(_workspaceId: string, _baseDomain: string): Promise<boolean> {
    return true;
  }

  async findRecord(_workspaceId: string, _baseDomain: string): Promise<DNSRecord | null> {
    return null;
  }

  async recordExists(workspaceId: string, baseDomain: string): Promise<boolean> {
    const record = await this.findRecord(workspaceId, baseDomain);
    return record !== null;
  }
}

/**
 * Create a DNS A record for a workspace.
 * Uses Cloudflare proxy for automatic HTTPS.
 */
export async function createDNSRecord(
  workspaceId: string,
  ip: string,
  env: Env
): Promise<string> {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `ws-${workspaceId}`,
        content: ip,
        ttl: 60, // 1 minute TTL for fast updates
        proxied: true, // Enable Cloudflare proxy for HTTPS
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to create DNS record: ${response.status}`;
    throw new Error(message);
  }

  const data = await response.json() as { result: { id: string } };
  return data.result.id;
}

/**
 * Delete a DNS record by ID.
 */
export async function deleteDNSRecord(
  recordId: string,
  env: Env
): Promise<void> {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );

  // Ignore 404 errors (record already deleted)
  if (!response.ok && response.status !== 404) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to delete DNS record: ${response.status}`;
    throw new Error(message);
  }
}

/**
 * Update a DNS record with a new IP address.
 */
export async function updateDNSRecord(
  recordId: string,
  ip: string,
  env: Env
): Promise<void> {
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: ip,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { errors?: Array<{ message: string }> };
    const message = error.errors?.[0]?.message || `Failed to update DNS record: ${response.status}`;
    throw new Error(message);
  }
}

/**
 * Get the workspace URL from a workspace ID.
 */
export function getWorkspaceUrl(workspaceId: string, baseDomain: string): string {
  return `https://ws-${workspaceId}.${baseDomain}`;
}
