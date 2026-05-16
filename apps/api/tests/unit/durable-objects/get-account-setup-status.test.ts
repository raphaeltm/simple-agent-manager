import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { getAccountSetupStatus } from '../../../src/durable-objects/sam-session/tools/get-account-setup-status';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

vi.mock('@simple-agent-manager/shared', () => ({
  DEFAULT_MISSION_MAX_PER_PROJECT: 50,
  DEFAULT_SAM_SEARCH_LIMIT: 10,
  DEFAULT_SAM_SEARCH_MAX_LIMIT: 50,
  DEFAULT_VM_LOCATION: 'fsn1',
  DEFAULT_VM_SIZE: 'small',
  DEFAULT_WORKSPACE_PROFILE: 'full',
  KNOWLEDGE_ENTITY_TYPES: ['preference', 'context'],
  KNOWLEDGE_SOURCE_TYPES: ['explicit', 'inferred'],
  getDefaultLocationForProvider: vi.fn().mockReturnValue('fsn1'),
  getLocationsForProvider: vi.fn().mockReturnValue(['fsn1']),
  isPolicyCategory: vi.fn().mockReturnValue(true),
  isValidAgentType: vi.fn().mockReturnValue(true),
  isValidLocationForProvider: vi.fn().mockReturnValue(true),
  isValidProvider: vi.fn().mockReturnValue(true),
  resolvePolicyLimits: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/db/schema', () => ({
  credentials: {
    provider: 'credentials.provider',
    credentialType: 'credentials.credentialType',
    agentType: 'credentials.agentType',
    isActive: 'credentials.isActive',
    userId: 'credentials.userId',
  },
  githubInstallations: {
    installationId: 'githubInstallations.installationId',
    accountName: 'githubInstallations.accountName',
    accountType: 'githubInstallations.accountType',
    userId: 'githubInstallations.userId',
  },
  projects: {
    id: 'projects.id',
    name: 'projects.name',
    repository: 'projects.repository',
    status: 'projects.status',
    userId: 'projects.userId',
  },
}));

type QueryResult = Array<Record<string, unknown>>;

function queryReturning(result: QueryResult) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(result),
    }),
  };
}

function mockDrizzleResults(results: {
  credentials?: QueryResult;
  installations?: QueryResult;
  projects?: QueryResult;
}) {
  vi.mocked(drizzle).mockReturnValue({
    select: vi
      .fn()
      .mockReturnValueOnce(queryReturning(results.credentials ?? []))
      .mockReturnValueOnce(queryReturning(results.installations ?? []))
      .mockReturnValueOnce(queryReturning(results.projects ?? [])),
  });
}

function buildCtx(userId = 'user-123'): ToolContext {
  return {
    env: {
      DATABASE: {},
    },
    userId,
  };
}

describe('get_account_setup_status', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('reports a new user when no setup resources exist', async () => {
    mockDrizzleResults({});

    const result = await getAccountSetupStatus({}, buildCtx());

    expect(result).toMatchObject({
      is_new_user: true,
      is_fully_set_up: false,
      completed: 0,
      total: 4,
      github_installations: [],
      projects: [],
    });
  });

  it('counts only active credentials and active projects', async () => {
    mockDrizzleResults({
      credentials: [
        { provider: 'hetzner', credentialType: 'cloud-provider', isActive: true },
        { provider: 'anthropic', credentialType: 'agent-api-key', isActive: false },
      ],
      installations: [
        { installationId: 123, accountName: 'example-org', accountType: 'Organization' },
      ],
      projects: [
        {
          id: 'project-1',
          name: 'SAM',
          repository: 'raphaeltm/simple-agent-manager',
          status: 'active',
        },
      ],
    });

    const result = await getAccountSetupStatus({}, buildCtx());

    expect(result).toMatchObject({
      is_new_user: false,
      is_fully_set_up: false,
      completed: 3,
      total: 4,
      steps: {
        cloud_provider: { done: true },
        agent_key: { done: false },
        github_app: { done: true },
        project: { done: true },
      },
      projects: [
        {
          id: 'project-1',
          name: 'SAM',
          repository: 'raphaeltm/simple-agent-manager',
        },
      ],
    });
  });

  it('is registered with executeTool', async () => {
    mockDrizzleResults({
      credentials: [
        { provider: 'hetzner', credentialType: 'cloud-provider', isActive: true },
        { provider: 'anthropic', credentialType: 'agent-api-key', isActive: true },
      ],
      installations: [
        { installationId: 123, accountName: 'example-org', accountType: 'Organization' },
      ],
      projects: [
        {
          id: 'project-1',
          name: 'SAM',
          repository: 'raphaeltm/simple-agent-manager',
          status: 'active',
        },
      ],
    });

    const toolCall: CollectedToolCall = {
      id: 'call-1',
      name: 'get_account_setup_status',
      input: {},
    };

    const result = await executeTool(toolCall, buildCtx());

    expect(result).toMatchObject({
      is_fully_set_up: true,
      completed: 4,
      total: 4,
    });
  });
});
