import { describe, expect, it } from 'vitest';
import { getNodeBackendHostname, getBackendHostname, getWorkspaceUrl } from '../../../src/services/dns';

describe('DNS hostname construction', () => {
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
});
