import { describe, expect, it } from 'vitest';

import { parseWorkspaceSubdomain } from '../../../src/lib/workspace-subdomain';

// Valid ULID: 26 uppercase alphanumeric characters
const VALID_ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const VALID_ULID_LOWER = '01arz3ndektsv4rrffq69g5fav';

describe('parseWorkspaceSubdomain', () => {
  const baseDomain = 'example.com';

  describe('standard workspace subdomains', () => {
    it('parses ws-{id}.{domain} into workspace ID', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID}.example.com`, baseDomain);
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: null });
    });

    it('uppercases workspace ID from DNS hostname', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}.example.com`, baseDomain);
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: null });
    });
  });

  describe('port-specific subdomains', () => {
    it('parses ws-{id}--{port}.{domain} into workspace ID and port', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--3000.example.com`, baseDomain);
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: 3000 });
    });

    it('parses port 80', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--80.example.com`, baseDomain);
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: 80 });
    });

    it('parses port 65535', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--65535.example.com`, baseDomain);
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: 65535 });
    });

    it('rejects port 0', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--0.example.com`, baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects port > 65535', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--99999.example.com`, baseDomain);
      expect(result).toEqual({ error: 'Port must be between 1 and 65535' });
    });

    it('rejects negative port', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}---1.example.com`, baseDomain);
      expect(result).toEqual({ error: "Unknown subdomain suffix: -1" });
    });

    it('rejects trailing -- with empty port', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--.example.com`, baseDomain);
      expect(result).toEqual({ error: "Unknown subdomain suffix: " });
    });

    it('rejects partial numeric port like 3000abc', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--3000abc.example.com`, baseDomain);
      expect(result).toEqual({ error: "Unknown subdomain suffix: 3000abc" });
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
      expect(parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}.other.com`, baseDomain)).toBeNull();
    });

    it('returns null for empty base domain', () => {
      expect(parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}.example.com`, '')).toBeNull();
    });

    it('returns null for bare base domain', () => {
      expect(parseWorkspaceSubdomain('example.com', baseDomain)).toBeNull();
    });
  });

  describe('ULID validation', () => {
    it('rejects workspace ID that is too short', () => {
      const result = parseWorkspaceSubdomain('ws-ABC123.example.com', baseDomain);
      expect(result).toEqual({ error: 'Invalid workspace ID format' });
    });

    it('rejects workspace ID that is too long', () => {
      const result = parseWorkspaceSubdomain('ws-01ARZ3NDEKTSV4RRFFQ69G5FAVX.example.com', baseDomain);
      expect(result).toEqual({ error: 'Invalid workspace ID format' });
    });

    it('rejects workspace ID with special characters', () => {
      const result = parseWorkspaceSubdomain('ws-01ARZ3NDEK/SV4RRFFQ69G5FA.example.com', baseDomain);
      expect(result).toEqual({ error: 'Invalid workspace ID format' });
    });
  });

  describe('edge cases', () => {
    it('handles multi-level base domain with port', () => {
      const result = parseWorkspaceSubdomain(`ws-${VALID_ULID_LOWER}--8080.staging.example.com`, 'staging.example.com');
      expect(result).toEqual({ workspaceId: VALID_ULID, targetPort: 8080 });
    });

    it('returns error for empty workspace ID', () => {
      const result = parseWorkspaceSubdomain('ws-.example.com', baseDomain);
      expect(result).toEqual({ error: 'Invalid workspace subdomain' });
    });
  });
});
