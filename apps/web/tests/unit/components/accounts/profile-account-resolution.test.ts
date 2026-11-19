/**
 * The client-side explanation of which account a profile's run uses. It runs
 * the shared resolver over the listed rows, so these cases pin the mapping from
 * the resolver's trace to what the editor shows.
 */
import type { CCProfileAttachmentItem } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

import {
  type AccountsSnapshot,
  buildAccountsModel,
} from '../../../../src/components/accounts/account-model';
import { explainProfileAccount } from '../../../../src/components/accounts/profile-account-resolution';
import { describeCredential } from '../../../../src/components/project-message-view/SessionRunDetails';
import { accountRows, mergeRows } from './fixtures';

function pin(
  profileId: string,
  configurationId: string,
  agentType = 'claude-code'
): CCProfileAttachmentItem {
  return {
    id: `pin-${profileId}-${agentType}`,
    configurationId,
    agentProfileId: profileId,
    profileName: profileId,
    projectId: 'p-web',
    projectName: 'Marketing site',
    consumerKind: 'agent',
    consumerTarget: agentType,
    isActive: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const rows = mergeRows(
  accountRows({ id: 'work', name: 'Work', kind: 'agent', target: 'claude-code', isDefault: true }),
  accountRows({
    id: 'client',
    name: 'Client',
    kind: 'agent',
    target: 'claude-code',
    pins: ['p-web'],
  }),
  accountRows({ id: 'max', name: 'Max', kind: 'agent', target: 'claude-code' }),
  accountRows({
    id: 'codex',
    name: 'Codex Pro',
    kind: 'agent',
    target: 'openai-codex',
    isDefault: true,
  })
);

function explain(
  profilePins: CCProfileAttachmentItem[],
  runAgentType?: string,
  projectId: string | null = 'p-web'
) {
  const snapshot: AccountsSnapshot = {
    ...rows,
    profilePins,
    projects: [{ id: 'p-web', name: 'Marketing site' }],
    resolution: [],
    limits: [],
  };
  const model = buildAccountsModel(snapshot);
  const agent = runAgentType ?? 'claude-code';
  const group = model.agents.find((candidate) => candidate.provider.id === agent)!;
  return explainProfileAccount(snapshot, group.accounts, {
    profileId: 'prof-1',
    agentType: 'claude-code',
    projectId,
    runAgentType,
  });
}

describe('explainProfileAccount', () => {
  it('a profile pin wins; my usual account is the project pin', () => {
    const result = explain([pin('prof-1', 'cfg-max')]);

    expect(result.outcome).toMatchObject({
      kind: 'account',
      tier: 'profile',
      account: { label: 'Max' },
    });
    expect(result.usual).toMatchObject({
      kind: 'account',
      tier: 'project',
      account: { label: 'Client' },
    });
    expect(result.needsAttention).toBe(false);
    expect(result.steps.map((step) => [step.tier, step.state])).toEqual([
      ['profile', 'used'],
      ['project', 'not-reached'],
      ['user', 'not-reached'],
      ['platform', 'not-reached'],
    ]);
  });

  it('a skill that switches the agent skips the pin and flags it', () => {
    const result = explain([pin('prof-1', 'cfg-max')], 'openai-codex');

    expect(result.outcome).toMatchObject({
      kind: 'account',
      tier: 'user',
      account: { label: 'Codex Pro' },
    });
    expect(result.steps[0]).toMatchObject({
      tier: 'profile',
      state: 'skipped',
      reason: 'agent-type-mismatch',
      pinnedAgentType: 'claude-code',
    });
    expect(result.needsAttention).toBe(true);
    expect(result.pin).toBeNull();
  });

  it('a global profile has no project tier', () => {
    const result = explain([], undefined, null);

    expect(result.steps.map((step) => step.tier)).toEqual(['profile', 'user', 'platform']);
    expect(result.outcome).toMatchObject({
      kind: 'account',
      tier: 'user',
      account: { label: 'Work' },
    });
  });
});

describe('describeCredential (session details)', () => {
  const base = { agentType: 'claude-code', credentialSource: 'user' as const, accountName: 'Max' };

  it('names my account and the profile tier', () => {
    expect(describeCredential({ ...base, credentialScope: 'profile', isOwnSession: true })).toBe(
      'Max · chosen for this profile'
    );
  });

  it('never names another member’s account', () => {
    expect(
      describeCredential({
        ...base,
        accountName: null,
        credentialScope: 'user',
        isOwnSession: false,
      })
    ).toBe('Their own account · their default');
  });

  it('reports the SAM platform', () => {
    expect(
      describeCredential({
        ...base,
        credentialSource: 'platform',
        credentialScope: 'platform',
        isOwnSession: true,
      })
    ).toBe('SAM platform account');
  });
});
