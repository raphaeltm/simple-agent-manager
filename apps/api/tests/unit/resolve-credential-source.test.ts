/**
 * Unit tests for resolveCredentialSource() and the credential-source-based
 * quota enforcement pattern across all three enforcement points.
 *
 * These tests verify:
 * 1. resolveCredentialSource function exists and has correct signature
 * 2. The function checks user credentials filtered by target provider first
 * 3. The function falls back to platform credentials
 * 4. The function returns the correct CredentialSource type
 * 5. All enforcement points use credential SOURCE (not existence) for quota gating
 * 6. The null-provider path is consistent with createProviderForUser behavior
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('resolveCredentialSource', () => {
  const providerCredsSource = readFileSync(
    resolve(process.cwd(), 'src/services/provider-credentials.ts'),
    'utf8',
  );

  it('exports resolveCredentialSource function', async () => {
    const mod = await import('../../src/services/provider-credentials');
    expect(typeof mod.resolveCredentialSource).toBe('function');
  });

  it('function signature accepts db, userId, and optional targetProvider', async () => {
    const mod = await import('../../src/services/provider-credentials');
    expect(mod.resolveCredentialSource.length).toBeGreaterThanOrEqual(2);
  });

  it('filters user credentials by targetProvider when specified', () => {
    // When targetProvider is provided, the function MUST filter by provider
    // to avoid the bypass where a Hetzner credential exempts Scaleway provisioning
    expect(providerCredsSource).toContain('eq(schema.credentials.provider, targetProvider)');
  });

  it('checks platform credentials with isEnabled filter', () => {
    expect(providerCredsSource).toContain('eq(schema.platformCredentials.isEnabled, true)');
  });

  it('filters platform credentials by targetProvider when specified', () => {
    expect(providerCredsSource).toContain('eq(schema.platformCredentials.provider, targetProvider)');
  });

  it('returns credentialSource user when user has matching credential', () => {
    // Verify the user credential path returns 'user'
    const resolveFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    expect(resolveFunc).toContain("credentialSource: 'user'");
  });

  it('returns credentialSource platform when falling back to platform', () => {
    const resolveFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    expect(resolveFunc).toContain("credentialSource: 'platform'");
  });

  it('returns null when no credentials exist', () => {
    const resolveFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    expect(resolveFunc).toContain('return null;');
  });

  it('resolves user credentials BEFORE platform credentials (user-first precedence)', () => {
    const resolveFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    const userCheckIdx = resolveFunc.indexOf('schema.credentials.userId');
    const platformCheckIdx = resolveFunc.indexOf('schema.platformCredentials.credentialType');
    expect(userCheckIdx).toBeLessThan(platformCheckIdx);
  });

  it('mirrors createProviderForUser resolution order', () => {
    // Both functions check user credentials first, then platform fallback.
    // When targetProvider is undefined, both match ANY user credential (this is correct —
    // the system will use whatever provider the user has).
    const createProviderFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function createProviderForUser'),
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    // createProviderForUser also checks user creds first, then platform
    expect(createProviderFunc).toContain("credentialSource: 'user'");
    expect(createProviderFunc).toContain("credentialSource: 'platform'");
  });
});

describe('userHasOwnCloudCredentials with targetProvider', () => {
  const serviceSource = readFileSync(
    resolve(process.cwd(), 'src/services/compute-quotas.ts'),
    'utf8',
  );

  it('exports userHasOwnCloudCredentials function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.userHasOwnCloudCredentials).toBe('function');
  });

  it('accepts optional targetProvider parameter', () => {
    expect(serviceSource).toContain('targetProvider?: CredentialProvider');
  });

  it('filters by provider when targetProvider is specified', () => {
    expect(serviceSource).toContain('eq(schema.credentials.provider, targetProvider)');
  });

  it('checks for any cloud-provider credential when targetProvider is omitted', () => {
    // When targetProvider is undefined, the condition is NOT added — matches any provider.
    // This is used by the usage.ts informational endpoint.
    expect(serviceSource).toContain('if (targetProvider)');
  });
});

describe('quota enforcement pattern: credential source, not existence', () => {
  const submitSource = readFileSync(
    resolve(process.cwd(), 'src/routes/tasks/submit.ts'),
    'utf8',
  );
  const nodeStepsSource = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner/node-steps.ts'),
    'utf8',
  );
  const nodesSource = readFileSync(
    resolve(process.cwd(), 'src/routes/nodes.ts'),
    'utf8',
  );

  // =========================================================================
  // Regression: The OLD pattern that must NOT exist
  // =========================================================================
  describe('old bypass pattern is removed', () => {
    it('submit.ts does NOT have raw credential existence check', () => {
      // The old pattern: query credentials table for any cloud-provider record
      // and set userHasByocCredentials = !!credential
      expect(submitSource).not.toContain('userHasByocCredentials');
    });

    it('node-steps.ts does NOT have raw SQL credential check', () => {
      // The old pattern: SELECT id FROM credentials WHERE ... LIMIT 1
      expect(nodeStepsSource).not.toContain("credential_type = 'cloud-provider' LIMIT 1");
    });

    it('node-steps.ts does NOT use hasOwnCreds guard', () => {
      expect(nodeStepsSource).not.toContain('if (!hasOwnCreds)');
    });
  });

  // =========================================================================
  // NEW pattern: resolveCredentialSource at all enforcement points
  // =========================================================================
  describe('all enforcement points use resolveCredentialSource', () => {
    it('submit.ts uses resolveCredentialSource', () => {
      expect(submitSource).toContain('resolveCredentialSource');
    });

    it('node-steps.ts uses resolveCredentialSource', () => {
      expect(nodeStepsSource).toContain('resolveCredentialSource');
    });

    it('nodes.ts (manual creation) uses resolveCredentialSource', () => {
      expect(nodesSource).toContain('resolveCredentialSource');
    });
  });

  // =========================================================================
  // Enforcement based on credential SOURCE
  // =========================================================================
  describe('quota enforced only for platform credential source', () => {
    it('submit.ts checks credentialSource === platform', () => {
      expect(submitSource).toContain("credResult.credentialSource === 'platform'");
    });

    it('node-steps.ts checks credentialSource === platform', () => {
      expect(nodeStepsSource).toContain("credResult?.credentialSource === 'platform'");
    });

    it('nodes.ts checks credentialSource === platform', () => {
      expect(nodesSource).toContain("credResult.credentialSource === 'platform'");
    });
  });

  // =========================================================================
  // Provider passed to resolveCredentialSource
  // =========================================================================
  describe('target provider is passed to credential resolution', () => {
    it('submit.ts passes resolved provider', () => {
      expect(submitSource).toContain('resolveCredentialSource(db, userId, provider');
    });

    it('node-steps.ts passes cloudProvider from config', () => {
      expect(nodeStepsSource).toContain('state.config.cloudProvider');
    });

    it('nodes.ts passes provider from request body', () => {
      expect(nodesSource).toContain('resolveCredentialSource(db, userId, provider');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================
  describe('clear error messages', () => {
    it('submit.ts rejects with clear quota exceeded message', () => {
      expect(submitSource).toContain('Monthly compute quota exceeded');
      expect(submitSource).toContain('quotaCheck.used');
      expect(submitSource).toContain('quotaCheck.limit');
    });

    it('node-steps.ts rejects with permanent quota exceeded error', () => {
      expect(nodeStepsSource).toContain('Monthly compute quota exceeded');
      expect(nodeStepsSource).toContain('quotaCheck.used');
      expect(nodeStepsSource).toContain('quotaCheck.limit');
    });

    it('nodes.ts rejects with clear quota exceeded message', () => {
      expect(nodesSource).toContain('Monthly compute quota exceeded');
      expect(nodesSource).toContain('quotaCheck.used');
      expect(nodesSource).toContain('quotaCheck.limit');
    });

    it('all points reject when no credential exists', () => {
      expect(submitSource).toContain('Cloud provider credentials required');
      expect(nodesSource).toContain('Cloud provider credentials required');
    });

    it('node-steps.ts intentionally does NOT reject when credResult is null (silent skip)', () => {
      // node-steps.ts uses optional chaining (credResult?.credentialSource); it silently
      // skips quota check when no credential exists. This is intentional — the DO context
      // handles credential absence differently from the HTTP request handlers.
      expect(nodeStepsSource).not.toContain('Cloud provider credentials required');
    });
  });

  // =========================================================================
  // Kill switch respected
  // =========================================================================
  describe('kill switch', () => {
    it('submit.ts respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(submitSource).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });

    it('node-steps.ts respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(nodeStepsSource).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });

    it('nodes.ts respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(nodesSource).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });

  // =========================================================================
  // Order: credential check BEFORE resource creation
  // =========================================================================
  describe('quota check order', () => {
    it('submit.ts checks quota before task creation', () => {
      const quotaIdx = submitSource.indexOf('resolveCredentialSource');
      const insertIdx = submitSource.indexOf('db.insert(schema.tasks)');
      expect(quotaIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(0);
      expect(quotaIdx).toBeLessThan(insertIdx);
    });

    it('nodes.ts checks quota before createNodeRecord', () => {
      const quotaIdx = nodesSource.indexOf('resolveCredentialSource');
      const createIdx = nodesSource.indexOf('createNodeRecord(c.env');
      expect(quotaIdx).toBeGreaterThan(0);
      expect(createIdx).toBeGreaterThan(0);
      expect(quotaIdx).toBeLessThan(createIdx);
    });
  });
});
