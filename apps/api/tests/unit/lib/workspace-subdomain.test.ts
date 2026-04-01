import { describe, expect,it } from 'vitest';

import { parseWorkspaceSubdomain } from '../../../src/lib/workspace-subdomain';

describe('parseWorkspaceSubdomain', () => {
  const baseDomain = 'example.com';

  describe('standard workspace subdomains', () => {
    it('parses ws-{id}.{domain} into workspace ID', () => {
      const result = parseWorkspaceSubdomain('ws-abc123def.example.com', baseDomain);
      expect(result).toEqual({ workspaceId: 'ABC123DEF', targetPort: null });
    });

    it('uppercases workspace ID from DNS hostname', () => {
      const result = parseWorkspaceSubdomain('ws-01khrjgan.example.com', baseDomain);
      expect(result).toEqual({ workspaceId: '01KHRJGAN', targetPort: null });
    });
  });

  describe('port-specific subdomains', () => {
    it('parses ws-{id}--{port}.{domain} into workspace ID and port', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--3000.example.com', baseDomain);
      expect(result).toEqual({ workspaceId: 'ABC123', targetPort: 3000 });
    });

    it('parses port 80', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--80.example.com', baseDomain);
      expect(result).toEqual({ workspaceId: 'ABC123', targetPort: 80 });
    });

    it('parses port 65535', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--65535.example.com', baseDomain);
      expect(result).toEqual({ workspaceId: 'ABC123', targetPort: 65535 });
    });

    it('rejects port 0', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--0.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects port > 65535', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--99999.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects non-numeric port', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--notaport.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects negative port', () => {
      const result = parseWorkspaceSubdomain('ws-abc123---1.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects trailing -- with empty port', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects partial numeric port like 3000abc', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--3000abc.example.com', baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });
  });

  describe('non-workspace hostnames', () => {
    it('returns null for non-ws subdomain', () => {
      expect(parseWorkspaceSubdomain('app.example.com', baseDomain)).toBeNull();
    });

    it('returns null for api subdomain', () => {
      expect(parseWorkspaceSubdomain('api.example.com', baseDomain)).toBeNull();
    });

    it('returns null for different base domain', () => {
      expect(parseWorkspaceSubdomain('ws-abc123.other.com', baseDomain)).toBeNull();
    });

    it('returns null for empty base domain', () => {
      expect(parseWorkspaceSubdomain('ws-abc123.example.com', '')).toBeNull();
    });

    it('returns null for bare base domain', () => {
      expect(parseWorkspaceSubdomain('example.com', baseDomain)).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles multi-level base domain', () => {
      const result = parseWorkspaceSubdomain('ws-abc123--8080.staging.example.com', 'staging.example.com');
      expect(result).toEqual({ workspaceId: 'ABC123', targetPort: 8080 });
    });

    it('returns error for empty workspace ID', () => {
      const result = parseWorkspaceSubdomain('ws-.example.com', baseDomain);
      expect(result).toEqual({ error: 'Invalid workspace subdomain' });
    });
  });
});
