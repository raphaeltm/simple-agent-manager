import { vi } from 'vitest';

const dispatchTaskMocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
  },
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  resolveCredentialSource: vi.fn(),
  resolveTaskStartPlacementCredentialAttribution: vi.fn(),
  resolveAgentProfile: vi.fn(),
  generateTaskTitle: vi.fn(),
  requireRepositoryOwnerAccess: vi.fn(),
  startTaskRunnerDO: vi.fn(),
}));

export function getDispatchTaskMocks() {
  return dispatchTaskMocks;
}

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => dispatchTaskMocks.db),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: dispatchTaskMocks.resolveAgentProfile,
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: dispatchTaskMocks.resolveCredentialSource,
}));

vi.mock('../../../src/services/placement-resolver', () => ({
  resolveTaskStartPlacementCredentialAttribution:
    dispatchTaskMocks.resolveTaskStartPlacementCredentialAttribution,
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: dispatchTaskMocks.createSession,
  persistMessage: dispatchTaskMocks.persistMessage,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: dispatchTaskMocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: dispatchTaskMocks.startTaskRunnerDO,
}));

vi.mock('../../../src/routes/projects/_helpers', () => ({
  requireRepositoryOwnerAccess: dispatchTaskMocks.requireRepositoryOwnerAccess,
}));

export const dispatchProject = {
  id: 'proj-1',
  name: 'Project',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultAgentType: null,
  defaultLocation: null,
  agentDefaults: null,
  taskExecutionTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  warmNodeTimeoutMs: null,
};

export interface DispatchPlacementResolutionInput {
  userId: string;
  projectId: string;
  explicit?: {
    vmSize?: string | null;
    workspaceProfile?: string | null;
    taskMode?: string | null;
    agentType?: string | null;
  };
  inheritedCredentialAttribution?: {
    userId?: string | null;
    projectId?: string | null;
    source?: 'user' | 'project' | 'platform' | null;
  };
}

export function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  };
}

export function buildDispatchPlacementResolution(input: DispatchPlacementResolutionInput) {
  const inherited = input.inheritedCredentialAttribution ?? {};
  const credentialAttributionSource = inherited.source ?? 'user';
  return {
    placement: {
      vmSize: input.explicit?.vmSize ?? 'small',
      vmSizeSource: input.explicit?.vmSize ? 'task' : 'default',
      vmLocation: 'fsn1',
      explicitVmLocation: false,
      provider: 'hetzner',
      workspaceProfile: input.explicit?.workspaceProfile ?? 'full',
      devcontainerConfigName: null,
      taskMode: input.explicit?.taskMode ?? 'task',
      agentType: input.explicit?.agentType ?? null,
      resolvedReservation: {
        cpuMillis: 1000,
        memoryMb: 2048,
        diskMb: 20480,
        source: 'legacy-vm-size',
      },
    },
    credential: { credentialSource: 'user', providerName: 'hetzner' },
    capacityPoolSelection: null,
    quotaCredentialSource: 'user',
    capacityPlacementSnapshot: null,
    effectiveProvider: 'hetzner',
    credentialAttributionUserId: inherited.userId ?? input.userId,
    credentialAttributionProjectId:
      credentialAttributionSource === 'project'
        ? (inherited.projectId ?? input.projectId)
        : null,
    credentialAttributionSource,
  };
}

export function resetDispatchTaskMocks(options: { title?: string } = {}) {
  vi.clearAllMocks();
  dispatchTaskMocks.db.select.mockImplementation(() => selectRows([]));
  dispatchTaskMocks.db.select.mockImplementationOnce(() => selectRows([dispatchProject]));
  dispatchTaskMocks.resolveAgentProfile.mockResolvedValue(null);
  dispatchTaskMocks.resolveCredentialSource.mockResolvedValue({
    credentialSource: 'user',
    providerName: 'hetzner',
  });
  dispatchTaskMocks.resolveTaskStartPlacementCredentialAttribution.mockImplementation(
    (_db: unknown, input: DispatchPlacementResolutionInput) =>
      Promise.resolve(buildDispatchPlacementResolution(input))
  );
  dispatchTaskMocks.generateTaskTitle.mockResolvedValue(options.title ?? 'Generated task title');
  dispatchTaskMocks.requireRepositoryOwnerAccess.mockResolvedValue(undefined);
  dispatchTaskMocks.createSession.mockResolvedValue('session-1');
  dispatchTaskMocks.persistMessage.mockResolvedValue('message-1');
  dispatchTaskMocks.startTaskRunnerDO.mockResolvedValue(undefined);
}

export function buildDispatchCtx(
  parentTaskRow?: {
    id: string;
    dispatch_depth: number;
    user_id?: string;
    credential_attribution_user_id?: string | null;
    credential_attribution_project_id?: string | null;
    credential_attribution_source?: string | null;
  } | null
) {
  const hydratedParentTaskRow = parentTaskRow
    ? {
        user_id: 'user-1',
        credential_attribution_user_id: null,
        credential_attribution_project_id: null,
        credential_attribution_source: 'user',
        ...parentTaskRow,
      }
    : parentTaskRow;
  const bindCalls: unknown[][] = [];
  const statement = {
    bind: vi.fn((...args: unknown[]) => {
      bindCalls.push(args);
      return statement;
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(hydratedParentTaskRow ?? null),
  };

  return {
    ctx: {
      env: {
        DATABASE: {
          prepare: vi.fn(() => statement),
        },
        PROJECT_DATA: {
          idFromName: vi.fn(() => 'project-data-id'),
          get: vi.fn(() => ({
            fetch: vi.fn().mockResolvedValue(new Response('ok')),
          })),
        },
        AI: {},
        BASE_DOMAIN: 'example.com',
        BRANCH_NAME_PREFIX: 'sam/',
        BRANCH_NAME_MAX_LENGTH: '60',
      },
      userId: 'user-1',
    },
    bindCalls,
    statement,
  };
}
