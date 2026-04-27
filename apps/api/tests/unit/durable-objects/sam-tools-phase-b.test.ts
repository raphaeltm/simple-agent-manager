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
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({
      success: true,
      meta: { changes: options.runChanges ?? 1 },
    }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    batch: vi.fn().mockResolvedValue([]),
    _statement: mockStatement,
  };
}

/**
 * Queue a D1 query result for the next Drizzle call.
 * Drizzle D1 uses .raw() for field-mapped selects (returns T[][]) and
 * .all() for untyped selects (returns { results: T[] }).
 * Row values MUST be in the same order as the .select() fields.
 */
function queueD1Result(
  stmt: ReturnType<typeof mockD1>['_statement'],
  rows: Record<string, unknown>[],
) {
  // .all() path (for queries without field mapping)
  stmt.all.mockResolvedValueOnce({ results: rows, success: true });
  // .raw() path (for queries WITH field mapping — Drizzle D1 uses this)
  const rawRows = rows.map((r) => Object.values(r));
  stmt.raw.mockResolvedValueOnce(rawRows);
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

  it('rejects non-active task status', async () => {
    const ctx = buildCtx();
    // Task found but in completed status — should reject
    queueD1Result(ctx._db._statement, [
      { id: 'task-1', status: 'completed', workspace_id: null, project_id: 'proj-1', title: 'Done Task' },
    ]);
    const result = await stopSubtask({ taskId: 'task-1' }, ctx);
    const r = result as { error?: string };
    expect(r.error).toContain("'completed'");
    expect(r.error).toContain('only active tasks');
  });

  it('stops an owned running task without workspace', async () => {
    const ctx = buildCtx();
    // Task found, running, no workspace — should stop successfully
    queueD1Result(ctx._db._statement, [
      { id: 'task-1', status: 'running', workspace_id: null, project_id: 'proj-1', title: 'Test Task' },
    ]);
    const result = await stopSubtask({ taskId: 'task-1' }, ctx);
    const r = result as Record<string, unknown>;
    expect(r.stopped).toBe(true);
    expect(r.taskId).toBe('task-1');
    expect(r.previousStatus).toBe('running');
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

  it('rejects non-retryable task status', async () => {
    const ctx = buildCtx();
    queueD1Result(ctx._db._statement, [
      { id: 'task-1', status: 'running', description: 'Test', project_id: 'proj-1', mission_id: null, task_mode: 'task', agent_profile_hint: null, name: 'Proj', repository: 'owner/repo', installation_id: 'inst-1', default_branch: 'main', default_vm_size: null, default_provider: null, default_location: null, default_workspace_profile: null, default_agent_type: null, agent_defaults: null, task_execution_timeout_ms: null, max_workspaces_per_node: null, node_cpu_threshold_percent: null, node_memory_threshold_percent: null, warm_node_timeout_ms: null },
    ]);
    const result = await retrySubtask({ taskId: 'task-1' }, ctx);
    const r = result as { error?: string };
    expect(r.error).toContain("'running'");
    expect(r.error).toContain('only failed or cancelled');
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

  it('rejects non-active task status', async () => {
    const ctx = buildCtx();
    // Task found but completed — values order: id, status, workspaceId, projectId, title
    queueD1Result(ctx._db._statement, [
      { id: 'task-1', status: 'completed', workspace_id: 'ws-1', project_id: 'proj-1', title: 'Done' },
    ]);
    const result = await sendMessageToSubtask({ taskId: 'task-1', message: 'hello' }, ctx);
    const r = result as { error?: string };
    expect(r.error).toContain("'completed'");
    expect(r.error).toContain('only active tasks');
  });

  it('rejects task with no workspace', async () => {
    const ctx = buildCtx();
    // Active task but no workspace yet — values order: id, status, workspaceId, projectId, title
    queueD1Result(ctx._db._statement, [
      { id: 'task-1', status: 'running', workspace_id: null, project_id: 'proj-1', title: 'Running' },
    ]);
    const result = await sendMessageToSubtask({ taskId: 'task-1', message: 'hello' }, ctx);
    const r = result as { error?: string };
    expect(r.error).toContain('no workspace');
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

  it('cancels an owned mission', async () => {
    const ctx = buildCtx();
    // Mission query — values order: id, status, projectId, title
    queueD1Result(ctx._db._statement, [
      { id: 'mission-1', status: 'active', project_id: 'proj-1', title: 'Test Mission' },
    ]);
    const result = await cancelMission({ missionId: 'mission-1' }, ctx);
    const r = result as Record<string, unknown>;
    expect(r.cancelled).toBe(true);
    expect(r.missionId).toBe('mission-1');
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

  it('pauses an owned mission', async () => {
    const ctx = buildCtx();
    queueD1Result(ctx._db._statement, [
      { id: 'mission-1', status: 'active', project_id: 'proj-1', title: 'Test Mission' },
    ]);
    const result = await pauseMission({ missionId: 'mission-1' }, ctx);
    const r = result as Record<string, unknown>;
    expect(r.paused).toBe(true);
    expect(r.missionId).toBe('mission-1');
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

  it('resumes an owned mission', async () => {
    const ctx = buildCtx();
    queueD1Result(ctx._db._statement, [
      { id: 'mission-1', status: 'paused', project_id: 'proj-1', title: 'Test Mission' },
    ]);
    const result = await resumeMission({ missionId: 'mission-1' }, ctx);
    const r = result as Record<string, unknown>;
    expect(r.resumed).toBe(true);
    expect(r.missionId).toBe('mission-1');
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
