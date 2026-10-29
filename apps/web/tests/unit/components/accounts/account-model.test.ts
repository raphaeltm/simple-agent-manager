import {
  type CCCompositionSnapshot,
  type CCConsumerRef,
  resolveEnvironment,
} from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type AccountsSnapshot,
  buildAccountsModel,
  coveredProjectCount,
  isProviderInUse,
  type ProviderAccounts,
} from '../../../../src/components/accounts/account-model';
import { type AccountRows, accountRows, mergeRows, PROJECTS, resolutionStatus } from './fixtures';

function snapshot(rows: AccountRows, extra: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
  return { ...rows, projects: PROJECTS, resolution: [], limits: [], ...extra };
}

function agentGroup(model: ReturnType<typeof buildAccountsModel>, id: string): ProviderAccounts {
  const group = model.agents.find((candidate) => candidate.provider.id === id);
  if (!group) throw new Error(`no agent group ${id}`);
  return group;
}

function cloudGroup(model: ReturnType<typeof buildAccountsModel>, id: string): ProviderAccounts {
  const group = model.clouds.find((candidate) => candidate.provider.id === id);
  if (!group) throw new Error(`no cloud group ${id}`);
  return group;
}

const WORK = accountRows({
  id: 'work',
  name: 'Work',
  kind: 'agent',
  target: 'claude-code',
  credentialKind: 'oauth-token',
  isDefault: true,
  createdAt: '2026-09-01T00:00:00.000Z',
});
const CLIENT = accountRows({
  id: 'client',
  name: 'Acme',
  kind: 'agent',
  target: 'claude-code',
  pins: ['p-client'],
  createdAt: '2026-09-02T00:00:00.000Z',
});
const SPARE = accountRows({
  id: 'spare',
  name: 'Old personal key',
  kind: 'agent',
  target: 'claude-code',
  createdAt: '2026-09-03T00:00:00.000Z',
});

describe('buildAccountsModel', () => {
  it('assigns default, pinned and unattached roles and orders accounts by role', () => {
    const model = buildAccountsModel(snapshot(mergeRows(SPARE, CLIENT, WORK)));
    const claude = agentGroup(model, 'claude-code');

    expect(claude.accounts.map((account) => [account.label, account.role])).toEqual([
      ['Work', 'default'],
      ['Acme', 'pinned'],
      ['Old personal key', 'unattached'],
    ]);
    expect(claude.defaultAccount?.label).toBe('Work');
    expect(claude.accounts[1]?.pinnedProjectIds).toEqual(['p-client']);
  });

  it('resolves every project: pins win, the rest follow the default', () => {
    const model = buildAccountsModel(snapshot(mergeRows(WORK, CLIENT)));
    const claude = agentGroup(model, 'claude-code');

    expect(claude.resolutions.get('p-client')).toMatchObject({
      source: 'pinned',
      account: { label: 'Acme' },
    });
    for (const id of ['p-web', 'p-api', 'p-labs']) {
      expect(claude.resolutions.get(id)).toMatchObject({
        source: 'default',
        account: { label: 'Work' },
      });
    }
    expect(claude.segments.map((segment) => [segment.label, segment.projectIds.length])).toEqual([
      ['Work', 3],
      ['Acme', 1],
    ]);
    expect(coveredProjectCount(claude, 'cfg-work')).toBe(3);
    expect(coveredProjectCount(claude, 'cfg-client')).toBe(1);
  });

  it('blocks a project whose pin is paused instead of falling back to the default', () => {
    const paused = accountRows({
      id: 'paused',
      name: 'Paused client',
      kind: 'agent',
      target: 'claude-code',
      pins: [{ id: 'p-client', active: false }],
    });
    const model = buildAccountsModel(snapshot(mergeRows(WORK, paused)));
    const claude = agentGroup(model, 'claude-code');

    expect(claude.resolutions.get('p-client')).toMatchObject({
      source: 'blocked',
      reason: 'paused',
      account: { label: 'Paused client' },
    });
    expect(claude.accounts.find((account) => account.label === 'Paused client')).toMatchObject({
      role: 'pinned',
      pinnedProjectIds: [],
      pausedProjectIds: ['p-client'],
    });
    expect(claude.segments.find((segment) => segment.role === 'blocked')?.projectIds).toEqual([
      'p-client',
    ]);
    // The default still covers only the unpinned projects.
    expect(coveredProjectCount(claude, 'cfg-work')).toBe(3);
  });

  it('blocks a project pinned to an inactive credential', () => {
    const revoked = accountRows({
      id: 'revoked',
      name: 'Revoked key',
      kind: 'agent',
      target: 'claude-code',
      credentialActive: false,
      pins: ['p-api'],
    });
    const model = buildAccountsModel(snapshot(mergeRows(WORK, revoked)));

    expect(agentGroup(model, 'claude-code').resolutions.get('p-api')).toMatchObject({
      source: 'blocked',
      reason: 'inactive',
    });
  });

  it('falls back to the platform only when the resolver reports one', () => {
    const withPlatform = buildAccountsModel(
      snapshot(mergeRows(), {
        resolution: [
          resolutionStatus({
            consumerId: 'claude-code',
            consumerKind: 'agent',
            source: 'platform',
          }),
        ],
      })
    );
    const claude = agentGroup(withPlatform, 'claude-code');
    expect(claude.platformFallback).toBe(true);
    expect(isProviderInUse(claude)).toBe(true);
    expect(claude.resolutions.get('p-web')).toEqual({ source: 'platform' });

    const without = agentGroup(buildAccountsModel(snapshot(mergeRows())), 'claude-code');
    expect(without.platformFallback).toBe(false);
    expect(isProviderInUse(without)).toBe(false);
    expect(without.resolutions.get('p-web')).toEqual({ source: 'none' });
  });

  it('keeps agents and clouds apart and counts credentials no configuration uses', () => {
    const hetzner = accountRows({
      id: 'hz',
      name: 'Hetzner — Personal',
      kind: 'compute',
      target: 'hetzner',
      isDefault: true,
    });
    const rows = mergeRows(WORK, hetzner);
    rows.credentials.push({
      id: 'cred-orphan',
      name: 'Imported key',
      kind: 'api-key',
      isActive: true,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const model = buildAccountsModel(snapshot(rows));

    expect(cloudGroup(model, 'hetzner').defaultAccount?.label).toBe('Hetzner — Personal');
    expect(agentGroup(model, 'claude-code').accounts).toHaveLength(1);
    expect(model.agents.some((group) => group.provider.id === 'hetzner')).toBe(false);
    expect(model.unlinkedCredentialCount).toBe(1);
  });

  it('attaches validation to the default account only', () => {
    const model = buildAccountsModel(
      snapshot(mergeRows(WORK, CLIENT), {
        resolution: [
          resolutionStatus({
            consumerId: 'claude-code',
            consumerKind: 'agent',
            source: 'user-attachment',
            validation: { status: 'invalid', message: 'Token expired' },
          }),
        ],
      })
    );
    const claude = agentGroup(model, 'claude-code');

    expect(claude.defaultAccount?.validation).toEqual({
      status: 'invalid',
      message: 'Token expired',
    });
    expect(claude.accounts.find((account) => account.role === 'pinned')?.validation).toBeNull();
  });
});

/**
 * The coverage bar promises which account each project is billed to, so it must
 * agree with the resolver the runtime uses. Build one snapshot, feed it to both,
 * and compare per project.
 */
describe('buildAccountsModel agrees with resolveEnvironment', () => {
  const USER_ID = 'user-1';
  const CONSUMER: CCConsumerRef = { kind: 'agent', agentType: 'claude-code' };

  function toResolverSnapshot(rows: AccountRows): CCCompositionSnapshot {
    return {
      credentials: rows.credentials.map((cred) => ({
        id: cred.id,
        ownerId: USER_ID,
        name: cred.name,
        kind: cred.kind,
        secret: 'secret',
        isActive: cred.isActive,
      })) as CCCompositionSnapshot['credentials'],
      configurations: rows.configurations.map((cfg) => ({
        id: cfg.id,
        ownerId: USER_ID,
        name: cfg.name,
        consumer: CONSUMER,
        credentialId: cfg.credentialId,
        settings: {},
        isActive: cfg.isActive,
      })),
      attachments: rows.attachments.map((att) => ({
        id: att.id,
        configurationId: att.configurationId,
        consumer: CONSUMER,
        target:
          att.projectId === null
            ? { scope: 'user' as const, userId: USER_ID }
            : { scope: 'project' as const, userId: USER_ID, projectId: att.projectId },
        isActive: att.isActive,
      })),
      platform: {},
    };
  }

  const SCENARIOS: Array<[string, AccountRows]> = [
    ['default plus a pin', mergeRows(WORK, CLIENT)],
    [
      'paused pin',
      mergeRows(
        WORK,
        accountRows({
          id: 'paused',
          name: 'Paused',
          kind: 'agent',
          target: 'claude-code',
          pins: [{ id: 'p-api', active: false }],
        })
      ),
    ],
    [
      'pin to an inactive configuration',
      mergeRows(
        WORK,
        accountRows({
          id: 'off',
          name: 'Off',
          kind: 'agent',
          target: 'claude-code',
          configurationActive: false,
          pins: ['p-web'],
        })
      ),
    ],
    [
      'inactive default',
      accountRows({
        id: 'stale',
        name: 'Stale',
        kind: 'agent',
        target: 'claude-code',
        credentialActive: false,
        isDefault: true,
      }),
    ],
    ['only unattached accounts', SPARE],
  ];

  it.each(SCENARIOS)('%s', (_name, rows) => {
    const claude = agentGroup(buildAccountsModel(snapshot(rows)), 'claude-code');
    const resolverSnapshot = toResolverSnapshot(rows);

    for (const project of PROJECTS) {
      const resolved = resolveEnvironment(resolverSnapshot, CONSUMER, {
        userId: USER_ID,
        projectId: project.id,
      });
      const ui = claude.resolutions.get(project.id);
      if (resolved === null) {
        expect(ui?.source, project.id).toMatch(/^(blocked|none)$/);
      } else {
        expect(ui && 'account' in ui ? ui.account?.configurationId : null, project.id).toBe(
          resolved.configuration?.id
        );
        expect(ui?.source, project.id).toBe(
          resolved.source === 'project-attachment' ? 'pinned' : 'default'
        );
      }
    }
  });
});
