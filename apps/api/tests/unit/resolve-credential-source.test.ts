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

import { resolveCredentialSource } from '../../src/services/provider-credentials';

function makeCredentialSourceDbMock(
  projectRows: unknown[],
  userRows: unknown[],
  platformRows: unknown[] = [],
) {
  const resultSets = [projectRows, userRows, platformRows];
  let selectCount = 0;

  const makeBuilder = () => ({
    from: () => makeBuilder(),
    innerJoin: () => makeBuilder(),
    leftJoin: () => makeBuilder(),
    where: () => makeBuilder(),
    limit: async () => resultSets[selectCount++] ?? [],
  });

  return {
    select: () => makeBuilder(),
  };
}

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

  it('resolves project credentials BEFORE user and platform credentials', () => {
    const resolveFunc = providerCredsSource.substring(
      providerCredsSource.indexOf('export async function resolveCredentialSource'),
    );
    const projectCheckIdx = resolveFunc.indexOf('resolveProjectComputeCredentialSource');
    const userCheckIdx = resolveFunc.indexOf('schema.credentials.userId');
    const platformCheckIdx = resolveFunc.indexOf('schema.platformCredentials.credentialType');
    expect(projectCheckIdx).toBeGreaterThanOrEqual(0);
    expect(projectCheckIdx).toBeLessThan(userCheckIdx);
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

describe('resolveCredentialSource project compute precedence', () => {
  it('returns project source when an active project attachment exists', async () => {
    const db = makeCredentialSourceDbMock(
      [{
        attachmentActive: true,
        consumerTarget: 'hetzner',
        configurationActive: true,
        credentialId: 'cc-project-cred',
        credentialActive: true,
      }],
      [{ id: 'personal-cred', provider: 'hetzner' }],
    );

    await expect(
      resolveCredentialSource(db as never, 'member-a', 'hetzner', 'project-1'),
    ).resolves.toEqual({ credentialSource: 'project', providerName: 'hetzner' });
  });

  it('halts on an inactive project attachment instead of falling through to personal credentials', async () => {
    const db = makeCredentialSourceDbMock(
      [{
        attachmentActive: false,
        consumerTarget: 'hetzner',
        configurationActive: true,
        credentialId: 'cc-project-cred',
        credentialActive: true,
      }],
      [{ id: 'personal-cred', provider: 'hetzner' }],
    );

    await expect(
      resolveCredentialSource(db as never, 'member-a', 'hetzner', 'project-1'),
    ).resolves.toBeNull();
  });

  it('falls back to the pinned creator personal credential when no project attachment exists', async () => {
    const db = makeCredentialSourceDbMock(
      [],
      [{ id: 'personal-cred', provider: 'hetzner' }],
    );

    await expect(
      resolveCredentialSource(db as never, 'member-a', 'hetzner', 'project-1'),
    ).resolves.toEqual({ credentialSource: 'user', providerName: 'hetzner' });
  });

  it('returns null when no project, personal, or platform credential exists', async () => {
    const db = makeCredentialSourceDbMock([], [], []);

    await expect(
      resolveCredentialSource(db as never, 'member-a', 'scaleway', 'project-1'),
    ).resolves.toBeNull();
  });
});

// Rule 28: every fallback branch for a NEW provider (vultr) must be behaviorally
// covered — active-project → user → platform → null — plus the critical
// "inactive scoped row does NOT fall through" invariant.
describe('resolveCredentialSource vultr fallback matrix (rule 28)', () => {
  const activeProjectRow = {
    attachmentActive: true,
    consumerTarget: 'vultr',
    configurationActive: true,
    credentialId: 'cc-vultr',
    credentialActive: true,
  };

  it('active project attachment → project', async () => {
    const db = makeCredentialSourceDbMock([activeProjectRow], [{ id: 'u', provider: 'vultr' }]);
    await expect(
      resolveCredentialSource(db as never, 'member-a', 'vultr', 'project-1'),
    ).resolves.toEqual({ credentialSource: 'project', providerName: 'vultr' });
  });

  it('inactive project attachment halts — does NOT fall through to the user vultr credential', async () => {
    const db = makeCredentialSourceDbMock(
      [{ ...activeProjectRow, attachmentActive: false }],
      [{ id: 'u', provider: 'vultr' }],
    );
    await expect(
      resolveCredentialSource(db as never, 'member-a', 'vultr', 'project-1'),
    ).resolves.toBeNull();
  });

  it('no project attachment → user vultr credential', async () => {
    const db = makeCredentialSourceDbMock([], [{ id: 'u', provider: 'vultr' }]);
    await expect(
      resolveCredentialSource(db as never, 'member-a', 'vultr', 'project-1'),
    ).resolves.toEqual({ credentialSource: 'user', providerName: 'vultr' });
  });

  it('no project, no user → platform vultr credential', async () => {
    const db = makeCredentialSourceDbMock([], [], [{ id: 'p', provider: 'vultr' }]);
    await expect(
      resolveCredentialSource(db as never, 'member-a', 'vultr', 'project-1'),
    ).resolves.toEqual({ credentialSource: 'platform', providerName: 'vultr' });
  });

  it('nothing at any tier → null', async () => {
    const db = makeCredentialSourceDbMock([], [], []);
    await expect(
      resolveCredentialSource(db as never, 'member-a', 'vultr', 'project-1'),
    ).resolves.toBeNull();
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
  const dispatchSource = readFileSync(
    resolve(process.cwd(), 'src/routes/mcp/dispatch-tool.ts'),
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

    it('dispatch-tool.ts does NOT have raw credential existence check in Promise.all', () => {
      // The old pattern: query credentials table in parallel and gate on !credential
      expect(dispatchSource).not.toContain("eq(schema.credentials.credentialType, 'cloud-provider')");
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

    it('dispatch-tool.ts (MCP dispatch) uses resolveCredentialSource', () => {
      expect(dispatchSource).toContain('resolveCredentialSource');
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
      expect(nodeStepsSource).toContain("credResult.credentialSource === 'platform'");
    });

    it('nodes.ts checks credentialSource === platform', () => {
      expect(nodesSource).toContain("credResult.credentialSource === 'platform'");
    });

    it('dispatch-tool.ts checks credentialSource === platform', () => {
      expect(dispatchSource).toContain("credResult.credentialSource === 'platform'");
    });
  });

  // =========================================================================
  // Provider passed to resolveCredentialSource
  // =========================================================================
  describe('target provider is passed to credential resolution', () => {
    it('submit.ts passes root or inherited project scope', () => {
      expect(submitSource).toContain('credentialResolutionProjectId');
      expect(submitSource).toContain('provider ?? undefined');
    });

    it('node-steps.ts passes cloudProvider from config', () => {
      expect(nodeStepsSource).toContain('state.config.cloudProvider');
    });

    it('nodes.ts passes provider from request body for user-scoped manual creation', () => {
      expect(nodesSource).toContain('resolveCredentialSource(db, userId, provider ?? undefined)');
    });

    it('dispatch-tool.ts passes inherited root attribution scope', () => {
      expect(dispatchSource).toContain('inheritedAttributionUserId');
      expect(dispatchSource).toContain('inheritedAttributionProjectId');
      expect(dispatchSource).toContain('resolvedProvider ?? undefined');
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
      expect(dispatchSource).toContain('Cloud provider credentials required');
    });

    it('node-steps.ts rejects with permanent error when no credential exists', () => {
      // node-steps.ts now has an explicit null check matching submit.ts and nodes.ts
      expect(nodeStepsSource).toContain('No cloud provider credentials available');
      expect(nodeStepsSource).toContain('{ permanent: true }');
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

    it('dispatch-tool.ts respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(dispatchSource).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
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

    it('dispatch-tool.ts checks quota before task INSERT', () => {
      const quotaIdx = dispatchSource.indexOf('resolveCredentialSource');
      const insertIdx = dispatchSource.indexOf('INSERT INTO tasks');
      expect(quotaIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(0);
      expect(quotaIdx).toBeLessThan(insertIdx);
    });
  });
});
