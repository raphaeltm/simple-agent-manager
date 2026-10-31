import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { recoverLegacyDeploymentBinding } from '../../../src/services/deployment-legacy-binding';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { createProviderForUser } from '../../../src/services/provider-credentials';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/provider-credentials', () => ({ createProviderForUser: vi.fn() }));

const CREATED = '2026-10-22T08:00:00.000Z';
const READY = '2026-10-22T08:05:00.000Z';
const UPDATED = '2026-10-21T08:00:00.000Z';

// Keep real credential selection, ownership predicates, fingerprinting and D1 writes;
// only the external provider construction/GET boundary is substituted.
describe('legacy deployment credential recovery', () => {
  let sqlite: Database.Database;
  let env: Env;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let node: schema.Node;
  let vm: {
    id: string;
    ip: string;
    location: string;
    createdAt: string;
    labels: Record<string, string>;
  };
  const getVM = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = {
      DATABASE: createSqliteD1(sqlite),
      ENCRYPTION_KEY: 'fixture-key',
      ENVIRONMENT: 'production',
      SAM_INSTALLATION_ID: 'a'.repeat(32),
    } as Env;
    db = drizzle(env.DATABASE, { schema });
    await db
      .insert(schema.users)
      .values({ id: 'owner', email: 'owner@example.test', name: 'Owner' });
    await db.insert(schema.credentials).values({
      id: 'cloud-key',
      userId: 'owner',
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      isActive: true,
      encryptedToken: 'ciphertext',
      iv: 'fixture-iv',
      createdAt: UPDATED,
      updatedAt: UPDATED,
    });
    await db.insert(schema.nodes).values({
      id: 'NODE-LEGACY',
      userId: 'owner',
      name: 'Healthy deployment',
      status: 'running',
      nodeRole: 'deployment',
      nodeClass: 'managed',
      runtime: 'vm',
      cloudProvider: 'hetzner',
      providerInstanceId: '150100869',
      ipAddress: '203.0.113.8',
      vmLocation: 'nbg1',
      credentialAttributionUserId: 'owner',
      credentialAttributionSource: 'user',
      createdAt: CREATED,
      agentReadyAt: READY,
      runtimeIncarnationId: null,
    });
    node = (await db.select().from(schema.nodes))[0]!;
    vm = {
      id: '150100869',
      ip: '203.0.113.8',
      location: 'nbg1',
      createdAt: '2026-10-22T08:01:00.000Z',
      labels: { node: 'node-legacy', managed: 'simple-agent-manager', role: 'deployment' },
    };
    getVM.mockImplementation(async () => vm);
    vi.mocked(createProviderForUser).mockResolvedValue({
      providerName: 'hetzner',
      credentialSource: 'user',
      provider: { getVM },
    } as unknown as NonNullable<Awaited<ReturnType<typeof createProviderForUser>>>);
  });
  afterEach(() => sqlite.close());

  async function stored() {
    return (await db.select().from(schema.nodes))[0]!;
  }
  async function expectUnbound() {
    expect(await recoverLegacyDeploymentBinding(env, node)).toBe(false);
    expect(await stored()).toMatchObject({
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
      placementCredentialFingerprint: null,
      status: 'running',
    });
  }

  it.each([CREATED, '2026-10-22T08:01:00.000Z', READY])(
    'binds positive legacy GET at boot window %s without disrupting the live node',
    async (createdAt) => {
      vm.createdAt = createdAt;
      const signal = new AbortController().signal;
      const fingerprint = await fingerprintEncryptedProviderCredential('ciphertext', 'fixture-iv');
      expect(await recoverLegacyDeploymentBinding(env, node, signal)).toBe(true);
      expect(getVM).toHaveBeenCalledWith('150100869', { signal });
      expect(createProviderForUser).toHaveBeenCalledWith(
        expect.anything(),
        'owner',
        'fixture-key',
        env,
        'hetzner',
        null,
        {
          credentialSource: 'user',
          credentialReference: 'credentials:cloud-key',
          credentialVersion: Date.parse(UPDATED),
          credentialFingerprint: fingerprint,
        }
      );
      expect(await stored()).toEqual({
        ...node,
        placementCredentialSource: 'user',
        placementCredentialReference: 'credentials:cloud-key',
        placementCredentialVersion: Date.parse(UPDATED),
        placementCredentialFingerprint: fingerprint,
      });
    }
  );

  it('never backfills from wrong-account 404 absence', async () => {
    getVM.mockResolvedValue(null);
    await expectUnbound();
  });

  it.each([
    ['node', 'foreign-node'],
    ['managed', 'someone-else'],
    ['role', 'workspace'],
    ['env', 'staging'],
    ['installation', 'b'.repeat(32)],
    ['incarnation', 'foreign-runtime'],
  ])('rejects foreign %s label', async (key, value) => {
    vm.labels[key] = value;
    await expectUnbound();
  });

  it.each(['node', 'managed', 'role', 'env', 'installation', 'incarnation'])(
    'rejects ambiguous %s label even with matching visible value',
    async (key) => {
      vm.labels[`__sam_internal_ambiguous_label__${key}`] = 'true';
      await expectUnbound();
    }
  );

  it.each([
    ['id', 'different-instance'],
    ['ip', '203.0.113.9'],
    ['location', 'hel1'],
    ['createdAt', '2026-10-22T07:59:59.999Z'],
    ['createdAt', '2026-10-22T08:05:00.001Z'],
    ['createdAt', 'invalid'],
  ])('rejects mismatched provider %s=%s', async (key, value) => {
    Object.assign(vm, { [key]: value });
    await expectUnbound();
  });

  it.each([
    'placementCredentialSource',
    'placementCredentialReference',
    'placementCredentialVersion',
    'placementCredentialFingerprint',
  ] as const)('does not complete or overwrite partial existing %s', async (key) => {
    const value = key === 'placementCredentialVersion' ? 42 : 'existing';
    await db
      .update(schema.nodes)
      .set({ [key]: value })
      .where(eq(schema.nodes.id, node.id));
    node = await stored();
    expect(await recoverLegacyDeploymentBinding(env, node)).toBe(false);
    expect(await stored()).toEqual(node);
    expect(getVM).not.toHaveBeenCalled();
  });

  it.each(['ENVIRONMENT', 'SAM_INSTALLATION_ID'] as const)(
    'requires configured %s before recovering ownership',
    async (key) => {
      delete env[key];
      await expectUnbound();
    }
  );

  it('rejects multiple active matching credentials without trying an account', async () => {
    await db.insert(schema.credentials).values({
      id: 'second-key',
      userId: 'owner',
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      isActive: true,
      encryptedToken: 'another-ciphertext',
      iv: 'another-iv',
      updatedAt: UPDATED,
    });
    await expectUnbound();
    expect(createProviderForUser).not.toHaveBeenCalled();
  });

  it('selects a single enabled platform credential without falling back to the user account', async () => {
    await db.insert(schema.platformCredentials).values({
      id: 'platform-key',
      provider: 'hetzner',
      credentialType: 'cloud-provider',
      label: 'Platform',
      encryptedToken: 'platform-ciphertext',
      iv: 'platform-iv',
      isEnabled: true,
      createdBy: 'owner',
      createdAt: UPDATED,
      updatedAt: UPDATED,
    });
    await db
      .update(schema.nodes)
      .set({ credentialAttributionSource: 'platform' })
      .where(eq(schema.nodes.id, node.id));
    node = await stored();
    expect(await recoverLegacyDeploymentBinding(env, node)).toBe(true);
    expect(await stored()).toMatchObject({
      placementCredentialSource: 'platform',
      placementCredentialReference: 'platform_credentials:platform-key',
      placementCredentialFingerprint: await fingerprintEncryptedProviderCredential(
        'platform-ciphertext',
        'platform-iv'
      ),
      placementCredentialVersion: Date.parse(UPDATED),
      status: 'running',
    });
  });

  it('selects the attributed project credential rather than the user fallback', async () => {
    await db
      .insert(schema.projects)
      .values({
        id: 'project',
        userId: 'owner',
        name: 'App',
        normalizedName: 'app',
        installationId: 'github-installation',
        repository: 'owner/app',
      });
    await db
      .insert(schema.credentials)
      .values({
        id: 'project-key',
        userId: 'owner',
        projectId: 'project',
        provider: 'hetzner',
        credentialType: 'cloud-provider',
        isActive: true,
        encryptedToken: 'project-ciphertext',
        iv: 'project-iv',
        createdAt: UPDATED,
        updatedAt: UPDATED,
      });
    await db
      .update(schema.nodes)
      .set({ credentialAttributionSource: 'project', credentialAttributionProjectId: 'project' })
      .where(eq(schema.nodes.id, node.id));
    node = await stored();
    expect(await recoverLegacyDeploymentBinding(env, node)).toBe(true);
    expect(createProviderForUser).toHaveBeenCalledWith(
      expect.anything(),
      'owner',
      'fixture-key',
      env,
      'hetzner',
      'project',
      expect.objectContaining({
        credentialSource: 'project',
        credentialReference: 'credentials:project-key',
      })
    );
    expect(await stored()).toMatchObject({
      placementCredentialSource: 'project',
      placementCredentialReference: 'credentials:project-key',
    });
  });

  it('fences a reincarnated node while the provider GET is in flight', async () => {
    getVM.mockImplementation(async () => {
      await db
        .update(schema.nodes)
        .set({ runtimeIncarnationId: 'replacement-runtime' })
        .where(eq(schema.nodes.id, node.id));
      return vm;
    });
    await expectUnbound();
    expect((await stored()).runtimeIncarnationId).toBe('replacement-runtime');
  });

  it.each([
    { ipAddress: '203.0.113.10' },
    { vmLocation: 'hel1' },
    { cloudProvider: 'vultr' },
    { agentReadyAt: '2026-10-22T09:00:00.000Z' },
    { createdAt: '2026-10-22T07:00:00.000Z' },
    { status: 'destroying' },
  ])('fences a concurrent node snapshot change %j', async (changes) => {
    getVM.mockImplementation(async () => {
      await db.update(schema.nodes).set(changes).where(eq(schema.nodes.id, node.id));
      return vm;
    });
    expect(await recoverLegacyDeploymentBinding(env, node)).toBe(false);
    expect(await stored()).toMatchObject({
      ...changes,
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
      placementCredentialFingerprint: null,
    });
  });

  it('fences credential rotation while the provider GET is in flight', async () => {
    getVM.mockImplementation(async () => {
      await db
        .update(schema.credentials)
        .set({ encryptedToken: 'rotated-ciphertext', updatedAt: READY })
        .where(eq(schema.credentials.id, 'cloud-key'));
      return vm;
    });
    await expectUnbound();
  });
});
