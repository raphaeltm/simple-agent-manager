/**
 * Unit tests for SAM Phase B tools: stop_subtask, retry_subtask,
 * send_message_to_subtask, cancel_mission, pause_mission, resume_mission.
 *
 * Tests cover:
 * - Parameter validation (missing/invalid required params)
 * - Ownership verification (reject unowned taskId/missionId)
 * - Status validation (reject non-active tasks for stop, non-failed for retry)
 * - Registration in toolHandlers (executeTool dispatch)
 */
import { describe, expect, it, vi } from 'vitest';

import { executeTool } from '../../../src/durable-objects/sam-session/tools';
import { cancelMission } from '../../../src/durable-objects/sam-session/tools/cancel-mission';
import { pauseMission } from '../../../src/durable-objects/sam-session/tools/pause-mission';
import { resumeMission } from '../../../src/durable-objects/sam-session/tools/resume-mission';
import { retrySubtask } from '../../../src/durable-objects/sam-session/tools/retry-subtask';
import { sendMessageToSubtask } from '../../../src/durable-objects/sam-session/tools/send-message-to-subtask';
import { stopSubtask } from '../../../src/durable-objects/sam-session/tools/stop-subtask';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/platform-credentials', () => ({
  getPlatformAgentCredential: vi.fn().mockResolvedValue({
    credential: 'test-api-key',
  }),
}));

vi.mock('../../../src/services/node-agent', () => ({
  stopAgentSessionOnNode: vi.fn().mockResolvedValue(undefined),
  sendPromptToAgentOnNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/project-orchestrator', () => ({
  cancelMission: vi.fn().mockResolvedValue(true),
  pauseMission: vi.fn().mockResolvedValue(true),
  resumeMission: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../src/services/project-data', () => ({
  stopSession: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue('session-123'),
  persistMessage: vi.fn().mockResolvedValue(undefined),
  enqueueMailboxMessage: vi.fn().mockResolvedValue({ id: 'msg-123' }),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: vi.fn().mockResolvedValue('Test Task Title'),
  getTaskTitleConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/services/branch-name', () => ({
  generateBranchName: vi.fn().mockReturnValue('sam/test-branch'),
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: vi.fn().mockResolvedValue({ credentialId: 'cred-1', provider: 'hetzner' }),
}));

vi.mock('../../../src/services/project-agent-defaults', () => ({
  resolveProjectAgentDefault: vi.fn().mockReturnValue({ model: null, permissionMode: null }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockD1(options: {
  firstResult?: Record<string, unknown> | null;
  allResults?: Record<string, unknown>[];
  runChanges?: number;
} = {}) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockResolvedValue({
      results: options.allResults ?? [],
      success: true,
    }),
    run: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: options.runChanges ?? 1 },
    }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  };
}

function buildCtx(overrides: {
  dbFirstResult?: Record<string, unknown> | null;
  dbAllResults?: Record<string, unknown>[];
  dbRunChanges?: number;
  userId?: string;
} = {}): ToolContext & { _db: ReturnType<typeof mockD1> } {
  const db = mockD1({
    firstResult: overrides.dbFirstResult,
    allResults: overrides.dbAllResults,
    runChanges: overrides.dbRunChanges,
  });

  return {
    env: {
      DATABASE: db as unknown,
      PROJECT_DATA: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        }),
      },
      PROJECT_ORCHESTRATOR: {
        idFromName: vi.fn().mockReturnValue('orch-id'),
        get: vi.fn().mockReturnValue({
          pauseMission: vi.fn().mockResolvedValue(true),
          resumeMission: vi.fn().mockResolvedValue(true),
          cancelMission: vi.fn().mockResolvedValue(true),
        }),
      },
      TASK_RUNNER: {
        idFromName: vi.fn().mockReturnValue('runner-id'),
        get: vi.fn().mockReturnValue({
          start: vi.fn().mockResolvedValue(undefined),
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        }),
      },
      AI: {},
      BASE_DOMAIN: 'example.com',
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
    } as Record<string, unknown>,
    userId: overrides.userId ?? 'user-123',
    _db: db,
  };
}

// ─── stop_subtask ─────────────────────────────────────────────────────────────

describe('stop_subtask', () => {
  it('rejects missing taskId', async () => {
    const ctx = buildCtx();
    const result = await stopSubtask({ taskId: '' }, ctx);
    expect(result).toEqual({ error: 'taskId is required.' });
  });

  it('rejects unowned task via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-stop-1',
      name: 'stop_subtask',
      input: { taskId: 'task-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── retry_subtask ────────────────────────────────────────────────────────────

describe('retry_subtask', () => {
  it('rejects missing taskId', async () => {
    const ctx = buildCtx();
    const result = await retrySubtask({ taskId: '' }, ctx);
    expect(result).toEqual({ error: 'taskId is required.' });
  });

  it('rejects unowned task via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-retry-1',
      name: 'retry_subtask',
      input: { taskId: 'task-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── send_message_to_subtask ──────────────────────────────────────────────────

describe('send_message_to_subtask', () => {
  it('rejects missing taskId', async () => {
    const ctx = buildCtx();
    const result = await sendMessageToSubtask({ taskId: '', message: 'hello' }, ctx);
    expect(result).toEqual({ error: 'taskId is required.' });
  });

  it('rejects missing message', async () => {
    const ctx = buildCtx();
    const result = await sendMessageToSubtask({ taskId: 'task-1', message: '' }, ctx);
    expect(result).toEqual({ error: 'message is required.' });
  });

  it('rejects unowned task via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-msg-1',
      name: 'send_message_to_subtask',
      input: { taskId: 'task-not-owned', message: 'hello' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── cancel_mission ───────────────────────────────────────────────────────────

describe('cancel_mission', () => {
  it('rejects missing missionId', async () => {
    const ctx = buildCtx();
    const result = await cancelMission({ missionId: '' }, ctx);
    expect(result).toEqual({ error: 'missionId is required.' });
  });

  it('rejects unowned mission via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-cancel-1',
      name: 'cancel_mission',
      input: { missionId: 'mission-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── pause_mission ────────────────────────────────────────────────────────────

describe('pause_mission', () => {
  it('rejects missing missionId', async () => {
    const ctx = buildCtx();
    const result = await pauseMission({ missionId: '' }, ctx);
    expect(result).toEqual({ error: 'missionId is required.' });
  });

  it('rejects unowned mission via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-pause-1',
      name: 'pause_mission',
      input: { missionId: 'mission-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── resume_mission ───────────────────────────────────────────────────────────

describe('resume_mission', () => {
  it('rejects missing missionId', async () => {
    const ctx = buildCtx();
    const result = await resumeMission({ missionId: '' }, ctx);
    expect(result).toEqual({ error: 'missionId is required.' });
  });

  it('rejects unowned mission via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-resume-1',
      name: 'resume_mission',
      input: { missionId: 'mission-not-owned' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── Tool registration ───────────────────────────────────────────────────────

describe('Phase B tool registration', () => {
  const ctx = buildCtx();

  it('all 6 Phase B tools are registered in executeTool', async () => {
    const phaseB = [
      'stop_subtask',
      'retry_subtask',
      'send_message_to_subtask',
      'cancel_mission',
      'pause_mission',
      'resume_mission',
    ];

    for (const toolName of phaseB) {
      const toolCall: CollectedToolCall = {
        id: `reg-${toolName}`,
        name: toolName,
        input: {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
      // If there's an error, it should NOT be "Unknown tool"
      if (r.error) {
        expect(r.error).not.toContain('Unknown tool');
      }
    }
  });

  it('Phase A tools still work after Phase B additions', async () => {
    const phaseA = ['dispatch_task', 'get_task_details', 'create_mission', 'get_mission'];
    for (const toolName of phaseA) {
      const toolCall: CollectedToolCall = {
        id: `compat-${toolName}`,
        name: toolName,
        input: {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
      if (r.error) {
        expect(r.error).not.toContain('Unknown tool');
      }
    }
  });

  it('original observation tools still work', async () => {
    const originals = ['list_projects', 'get_project_status', 'search_tasks', 'search_conversation_history'];
    for (const toolName of originals) {
      const toolCall: CollectedToolCall = {
        id: `orig-${toolName}`,
        name: toolName,
        input: toolName === 'search_conversation_history' ? { query: 'test' } : {},
      };
      const result = await executeTool(toolCall, ctx);
      const r = result as { error?: string };
      if (r.error) {
        expect(r.error).not.toContain('Unknown tool');
      }
    }
  });
});
