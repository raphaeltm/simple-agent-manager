import type { DNSRecord, DNSServiceInterface } from './dns';

/**
 * Mock DNS Service for local development
 *
 * Stores DNS records in memory. Records are lost when the API restarts.
 * This is intentional - mock mode is for development only.
 */
export class MockDNSService implements DNSServiceInterface {
  private records = new Map<string, DNSRecord>();

  /**
   * Create a wildcard A record for a workspace (in memory)
   */
  async createRecord(workspaceId: string, ip: string, baseDomain: string): Promise<DNSRecord> {
    const name = `*.${workspaceId}.vm.${baseDomain}`;

    const record: DNSRecord = {
      id: crypto.randomUUID(),
      name,
      type: 'A',
      content: ip,
      proxied: false,
      ttl: 1,
    };

    this.records.set(workspaceId, record);
    return record;
  }

  /**
   * Delete a DNS record by workspace ID (from memory)
   */
  async deleteRecord(workspaceId: string, _baseDomain: string): Promise<boolean> {
    return this.records.delete(workspaceId);
  }

  /**
   * Find a DNS record by workspace ID (in memory)
   */
  async findRecord(workspaceId: string, _baseDomain: string): Promise<DNSRecord | null> {
    return this.records.get(workspaceId) || null;
  }

  /**
   * Check if a DNS record exists for a workspace (in memory)
   */
  async recordExists(workspaceId: string, baseDomain: string): Promise<boolean> {
    const record = await this.findRecord(workspaceId, baseDomain);
    return record !== null;
  }
}
