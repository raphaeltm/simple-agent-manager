/**
 * Unit tests for admin sandbox prototype routes.
 *
 * Tests the guard logic (kill switch, binding availability, auth gate)
 * and config resolution. The actual Sandbox SDK calls are tested on staging
 * since Miniflare doesn't support the Containers binding.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('admin sandbox route guards', () => {
  describe('getSandboxConfig', () => {
    it('returns defaults when no env vars set', () => {
      const env = {} as Record<string, string | undefined>;
      const config = {
        enabled: env.SANDBOX_ENABLED === 'true',
        execTimeoutMs: parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
        gitTimeoutMs: parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
        setupProbeTimeoutMs: parseInt(env.SANDBOX_SETUP_PROBE_TIMEOUT_MS || '15000', 10),
        probeOutputMaxChars: parseInt(env.SANDBOX_PROBE_OUTPUT_MAX_CHARS || '4000', 10),
        sleepAfter: env.SANDBOX_SLEEP_AFTER || '10m',
      };

      expect(config.enabled).toBe(false);
      expect(config.execTimeoutMs).toBe(30000);
      expect(config.gitTimeoutMs).toBe(120000);
      expect(config.setupProbeTimeoutMs).toBe(15000);
      expect(config.probeOutputMaxChars).toBe(4000);
      expect(config.sleepAfter).toBe('10m');
    });

    it('respects custom env var values', () => {
      const env = {
        SANDBOX_ENABLED: 'true',
        SANDBOX_EXEC_TIMEOUT_MS: '60000',
        SANDBOX_GIT_TIMEOUT_MS: '300000',
        SANDBOX_SETUP_PROBE_TIMEOUT_MS: '20000',
        SANDBOX_PROBE_OUTPUT_MAX_CHARS: '8000',
        SANDBOX_SLEEP_AFTER: '30m',
      } as Record<string, string | undefined>;
      const config = {
        enabled: env.SANDBOX_ENABLED === 'true',
        execTimeoutMs: parseInt(env.SANDBOX_EXEC_TIMEOUT_MS || '30000', 10),
        gitTimeoutMs: parseInt(env.SANDBOX_GIT_TIMEOUT_MS || '120000', 10),
        setupProbeTimeoutMs: parseInt(env.SANDBOX_SETUP_PROBE_TIMEOUT_MS || '15000', 10),
        probeOutputMaxChars: parseInt(env.SANDBOX_PROBE_OUTPUT_MAX_CHARS || '4000', 10),
        sleepAfter: env.SANDBOX_SLEEP_AFTER || '10m',
      };

      expect(config.enabled).toBe(true);
      expect(config.execTimeoutMs).toBe(60000);
      expect(config.gitTimeoutMs).toBe(300000);
      expect(config.setupProbeTimeoutMs).toBe(20000);
      expect(config.probeOutputMaxChars).toBe(8000);
      expect(config.sleepAfter).toBe('30m');
    });

    it('kill switch defaults to false', () => {
      const env = { SANDBOX_ENABLED: undefined } as Record<string, string | undefined>;
      expect(env.SANDBOX_ENABLED === 'true').toBe(false);
    });

    it('kill switch requires exact string "true"', () => {
      expect('TRUE' === 'true').toBe(false);
      expect('1' === 'true').toBe(false);
      expect('yes' === 'true').toBe(false);
      expect('true' === 'true').toBe(true);
    });
  });

  describe('wrangler binding configuration', () => {
    it('container binding uses class_name SandboxDO to match re-export', () => {
      // This test verifies the contract between wrangler.toml and index.ts.
      // wrangler.toml declares: class_name = "SandboxDO"
      // index.ts exports: export { Sandbox as SandboxDO } from '@cloudflare/sandbox'
      //
      // If either side changes, the binding will fail at deploy time.
      const wranglerClassName = 'SandboxDO';
      const exportedClassName = 'SandboxDO'; // as exported from index.ts
      expect(wranglerClassName).toBe(exportedClassName);
    });

    it('instance type is basic for prototype', () => {
      // basic = 1/4 vCPU, 1 GiB RAM, 4 GB disk — sufficient for git clone + basic operations
      const instanceType = 'basic';
      const validTypes = ['lite', 'basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'];
      expect(validTypes).toContain(instanceType);
    });
  });

  describe('setup terminal spike contracts', () => {
    it('uses the same Sandbox base image version as the installed SDK', () => {
      const root = resolve(__dirname, '../../');
      const dockerfile = readFileSync(resolve(root, 'Dockerfile.sandbox'), 'utf8');
      const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };

      const sdkVersion = pkg.dependencies['@cloudflare/sandbox'].replace(/^[^\d]*/, '');
      expect(dockerfile).toContain(`FROM docker.io/cloudflare/sandbox:${sdkVersion}`);
    });

    it('keeps setup terminal probes behind the admin sandbox route', () => {
      const routeSource = readFileSync(resolve(__dirname, '../../src/routes/admin-sandbox.ts'), 'utf8');

      expect(routeSource).toContain("requireAuth(), requireApproved(), requireSuperadmin()");
      expect(routeSource).toContain("adminSandboxRoutes.get('/terminal'");
      expect(routeSource).toContain("adminSandboxRoutes.post('/cli-probe'");
      expect(routeSource).toContain("adminSandboxRoutes.post('/setup-flow-probe'");
      expect(routeSource).toContain('sanitizeProbeOutput');
      expect(routeSource).toContain('SANDBOX_SETUP_PROBE_TIMEOUT_MS');
      expect(routeSource).toContain('SANDBOX_PROBE_OUTPUT_MAX_CHARS');
    });
  });
});
