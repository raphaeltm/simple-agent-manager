/**
 * Unit tests for MCP create_trigger tool.
 *
 * Tests input validation and successful creation flow.
 * Uses direct D1 mock since the handler uses raw SQL (not Drizzle ORM).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockValidateCron = vi.fn().mockReturnValue({ valid: true, humanReadable: 'Every day at 9:00 AM' });
vi.mock('../../../src/services/cron-utils', () => ({
  validateCronExpression: (...args: unknown[]) => mockValidateCron(...args),
  cronToNextFire: vi.fn().mockReturnValue('2026-04-10T09:00:00.000Z'),
  cronToHumanReadable: vi.fn().mockReturnValue('Every day at 9:00 AM (UTC)'),
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'trigger-001',
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ─── D1 mock ────────────────────────────────────────────────────────────────

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    _stmt: stmt,
  };
}

// ─── Test setup ─────────────────────────────────────────────────────────────

import { handleCreateTrigger } from '../../../src/routes/mcp/trigger-tools';

const tokenData: McpTokenData = {
  taskId: 'task-001',
  projectId: 'proj-001',
  userId: 'user-001',
  workspaceId: 'ws-001',
  createdAt: '2026-04-07T00:00:00Z',
};

describe('MCP create_trigger tool', () => {
  let mockD1: ReturnType<typeof createMockD1>;
  let env: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    env = {
      DATABASE: mockD1 as unknown as D1Database,
      CRON_TEMPLATE_MAX_LENGTH: undefined,
      MAX_TRIGGERS_PER_PROJECT: undefined,
      CRON_MIN_INTERVAL_MINUTES: undefined,
    } as Partial<Env>;
  });

  it('creates a trigger successfully with required fields', async () => {
    // Name uniqueness check: no existing trigger
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Count check: below limit
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Daily Review',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Review all open PRs',
      },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.triggerId).toBe('trigger-001');
    expect(parsed.name).toBe('Daily Review');
    expect(parsed.status).toBe('active');
    expect(parsed.cronExpression).toBe('0 9 * * *');
    expect(parsed.cronHumanReadable).toBeDefined();
    expect(parsed.nextFireAt).toBeDefined();
  });

  it('rejects missing name', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('name is required');
  });

  it('rejects empty cron expression', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('cronExpression is required');
  });

  it('rejects empty prompt template', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: '   ' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('promptTemplate is required');
  });

  it('rejects prompt template exceeding max length', async () => {
    const longTemplate = 'x'.repeat(8001); // Default max is 8000
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: longTemplate },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('characters or less');
  });

  it('rejects invalid cron expression', async () => {
    mockValidateCron.mockReturnValueOnce({ valid: false, error: 'bad expression' });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: 'not-valid', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Invalid cron expression');
  });

  it('rejects invalid timezone', async () => {
    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', cronTimezone: 'Invalid/Zone', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Invalid timezone');
  });

  it('rejects agentProfileId not in project', async () => {
    // agentProfileId lookup: not found
    mockD1._stmt.first.mockResolvedValueOnce(null);

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        agentProfileId: 'nonexistent-profile',
      },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('agentProfileId not found');
  });

  it('rejects duplicate trigger name', async () => {
    // Name uniqueness check: existing trigger found
    mockD1._stmt.first.mockResolvedValueOnce({ id: 'existing-trigger' });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Daily Review', cronExpression: '0 9 * * *', promptTemplate: 'Review PRs' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('already exists');
  });

  it('rejects when max triggers reached', async () => {
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Count check: at limit (default 25)
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 25 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Maximum triggers per project');
  });

  it('uses default UTC timezone when not specified', async () => {
    mockD1._stmt.first.mockResolvedValueOnce(null);
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      { name: 'Test', cronExpression: '0 9 * * *', promptTemplate: 'Do stuff' },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeUndefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.cronTimezone).toBe('UTC');
  });

  it('accepts optional fields (agentProfileId, taskMode, vmSizeOverride)', async () => {
    // agentProfileId lookup: found
    mockD1._stmt.first.mockResolvedValueOnce({ id: 'profile-1' });
    // Name uniqueness: no conflict
    mockD1._stmt.first.mockResolvedValueOnce(null);
    // Count check: below limit
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Full Config',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        agentProfileId: 'profile-1',
        taskMode: 'conversation',
        vmSizeOverride: 'large',
      },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeUndefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.taskMode).toBe('conversation');
    expect(parsed.vmSizeOverride).toBe('large');
  });

  it('ignores invalid vmSizeOverride values', async () => {
    mockD1._stmt.first.mockResolvedValueOnce(null);
    mockD1._stmt.first.mockResolvedValueOnce({ cnt: 0 });

    const result = await handleCreateTrigger(
      'req-1',
      {
        name: 'Test',
        cronExpression: '0 9 * * *',
        promptTemplate: 'Do stuff',
        vmSizeOverride: 'xlarge',
      },
      tokenData,
      env as Env,
    );

    expect(result.error).toBeUndefined();
    const content = (result.result as { content: { text: string }[] }).content[0];
    const parsed = JSON.parse(content.text);
    expect(parsed.vmSizeOverride).toBeNull();
  });
});
