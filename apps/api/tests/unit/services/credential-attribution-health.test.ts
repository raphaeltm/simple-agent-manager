import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearCredentialAttributionHealthCache,
  getProjectCredentialAttributionHealth,
} from '../../../src/services/credential-attribution-health';

function makeDb(results: unknown[][]) {
  let callIndex = 0;
  return {
    select: () => ({
      from: () => {
        const chain = {
          innerJoin: () => chain,
          leftJoin: () => chain,
          where: async () => results[callIndex++] ?? [],
        };
        return chain;
      },
    }),
  };
}

const project = {
  id: 'proj-1',
  defaultAgentType: null,
  defaultProvider: null,
};

const trigger = {
  id: 'trigger-1',
  projectId: 'proj-1',
  userId: 'owner-1',
  name: 'Daily review',
  description: null,
  status: 'active',
  sourceType: 'cron',
  cronExpression: '0 9 * * *',
  cronTimezone: 'UTC',
  skipIfRunning: true,
  promptTemplate: 'Run review',
  agentProfileId: null,
  skillId: null,
  taskMode: 'task',
  vmSizeOverride: null,
  maxConcurrent: 1,
  lastTriggeredAt: null,
  triggerCount: 0,
  nextFireAt: null,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
};

const owner = {
  id: 'owner-1',
  name: 'Owner User',
  email: 'owner@example.com',
  avatarUrl: null,
};

describe('credential attribution health service', () => {
  beforeEach(() => {
    clearCredentialAttributionHealthCache();
  });
  it('counts personal trigger credential paths when no project coverage exists', async () => {
    const db = makeDb([
      [trigger],
      [],
      [owner],
    ]);

    const summary = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: false,
    });

    expect(summary.multiplayerActive).toBe(false);
    expect(summary.counts.resources).toBe(1);
    expect(summary.counts.personalResources).toBe(1);
    expect(summary.counts.personalCredentials).toBe(2);
    expect(summary.counts.projectCoveredCredentials).toBe(0);
    expect(summary.resources[0]?.checks.map((check) => check.source)).toEqual([
      'personal',
      'personal',
    ]);
    expect(summary.resources[0]?.checks[0]?.warning).toBe("This runs on Owner User's personal key.");
  });

  it('lets project attachment coverage win and does not leak secret material', async () => {
    const db = makeDb([
      [trigger],
      [
        {
          consumerKind: 'agent',
          consumerTarget: 'opencode',
          configurationId: 'cfg-agent',
          configurationName: 'Project OpenCode',
          credentialId: 'cred-agent',
          credentialName: 'OpenCode secret',
          ownerId: 'owner-1',
          encryptedToken: 'sk-secret',
          iv: 'secret-iv',
        },
        {
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          configurationId: 'cfg-compute',
          configurationName: 'Project Compute',
          credentialId: 'cred-compute',
          credentialName: 'Compute secret',
          ownerId: 'owner-1',
          encryptedToken: 'cloud-secret',
          iv: 'cloud-iv',
        },
      ],
      [owner],
    ]);

    const summary = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: true,
    });

    expect(summary.multiplayerActive).toBe(true);
    expect(summary.counts.personalResources).toBe(0);
    expect(summary.counts.personalCredentials).toBe(0);
    expect(summary.counts.projectCoveredCredentials).toBe(2);
    expect(summary.resources[0]?.checks.every((check) => check.source === 'project')).toBe(true);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('secret-iv');
    expect(serialized).not.toContain('encryptedToken');
    expect(serialized).not.toContain('"iv"');
  });

  it('reuses cached project health within the configured TTL', async () => {
    const db = makeDb([[trigger], [], [owner], []]);

    const first = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: false,
      env: { CREDENTIAL_ATTRIBUTION_CACHE_TTL_MS: '1000' },
    });
    const second = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: false,
      env: { CREDENTIAL_ATTRIBUTION_CACHE_TTL_MS: '1000' },
    });

    expect(second).toBe(first);
  });

  it('supports explicit credential attribution cache invalidation', async () => {
    const db = makeDb([[trigger], [], [owner], []]);

    const first = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: false,
      env: { CREDENTIAL_ATTRIBUTION_CACHE_TTL_MS: '1000' },
    });
    clearCredentialAttributionHealthCache(project.id);
    const second = await getProjectCredentialAttributionHealth({
      db: db as never,
      project,
      defaultAgentType: 'opencode',
      multiplayerActive: false,
      env: { CREDENTIAL_ATTRIBUTION_CACHE_TTL_MS: '1000' },
    });

    expect(second).not.toBe(first);
  });
});
