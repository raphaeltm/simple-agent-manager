/**
 * sam_team_status against a real SQL engine: the lineage, channel and chat scopes are SQL
 * predicates, so a foreign project's tasks are seeded beside the owner's and must never appear.
 * ProjectData (session summaries), the AI budget meter and provider limit windows are external
 * boundaries and are mocked; everything read from D1 runs the production queries.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { responseBytes, resultByteBudget } from '../../../src/operations/response-budget';
import { samTeamStatus } from '../../../src/operations/team-operations';
import type { OperationContext } from '../../../src/operations/types';
import { getConnectorReadLimits } from '../../../src/services/connector-read-settings';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  limits: vi.fn(),
  tokens: vi.fn(),
}));
vi.mock('../../../src/services/project-data', () => ({
  getSessionsByTaskIds: mocks.sessions,
}));
vi.mock('../../../src/services/credential-limit-events/read', () => ({
  listProjectCredentialLimits: mocks.limits,
}));
vi.mock('../../../src/services/ai-token-budget', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/ai-token-budget')>()),
  getTokenUsage: mocks.tokens,
  getUserBudgetSettings: vi.fn(async () => null),
}));
vi.mock('../../../src/services/connector-read-settings', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/connector-read-settings')>();
  return { ...actual, getConnectorReadLimits: vi.fn(actual.getConnectorReadLimits) };
});

/** A cap at which the wordy team fits only once its agent text is shortened (see that test). */
const SHORTEN_CAP = 50_000;

describe('sam_team_status', () => {
  let sqlite: Database.Database;
  let env: Env;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      requestId: 'test',
      actor: { userId, via: 'connector', scopes: new Set(['sam.read']) },
    };
  }

  function task(
    id: string,
    fields: Partial<Record<string, string | number | null>> = {}
  ): Record<string, string | number | null> {
    return {
      id,
      project_id: 'p',
      user_id: 'owner',
      title: `Task ${id}`,
      status: 'in_progress',
      execution_step: 'running',
      parent_task_id: null,
      triggered_by: 'mcp',
      dispatch_depth: 1,
      task_mode: 'task',
      created_at: '2026-10-25T08:00:00.000Z',
      updated_at: '2026-10-25T09:00:00.000Z',
      ...fields,
    };
  }

  function insertTask(row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO tasks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/other');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('viewer','Viewer','v@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','viewer','viewer','active'), ('foreign','outsider','owner','active');
    `);
    insertTask(
      task('root', {
        triggered_by: 'user',
        dispatch_depth: 0,
        chat_session_id: 'chat-root',
        workspace_id: 'ws-root',
        coordination_channel: 'feature.launch',
      })
    );
    insertTask(
      task('child', {
        parent_task_id: 'root',
        chat_session_id: 'chat-child',
        workspace_id: 'ws-child',
        output_pr_url: 'https://github.com/ACME/App/pull/7/',
        output_summary: 'Implemented the parser; tests pass.',
        admission_state: 'provider_limit_waiting',
        provider_limit_wait_json: JSON.stringify({ resetsAt: '2026-10-25T12:00:00.000Z' }),
        coordination_channel: 'feature.launch',
      })
    );
    insertTask(
      task('retry', {
        parent_task_id: 'root',
        triggered_by: 'user',
        dispatch_depth: 0,
        status: 'failed',
        execution_step: null,
        error_message: 'Rate limit exceeded on provider',
      })
    );
    insertTask(task('grandchild', { parent_task_id: 'child', dispatch_depth: 2 }));
    insertTask(task('great', { parent_task_id: 'grandchild', dispatch_depth: 3 }));
    // Attack fixtures: a foreign project's task naming our root as its parent, and a foreign
    // task on the same channel name.
    insertTask(
      task('foreign-child', {
        project_id: 'foreign',
        user_id: 'outsider',
        parent_task_id: 'root',
        coordination_channel: 'feature.launch',
      })
    );
    sqlite.exec(`
      INSERT INTO workspaces (id, project_id, user_id, node_id, name, repository, branch, vm_size, vm_location, status, chat_session_id)
        VALUES ('ws-child','p','owner','node','Child','acme/app','b','small','fsn1','running','chat-child');
      INSERT INTO agent_sessions (id, workspace_id, user_id, agent_type, agent_provider_mode, agent_credential_source, status, created_at)
        VALUES ('agent-child','ws-child','owner','claude-code','sam','platform','running','2026-10-25T08:30:00.000Z');
      INSERT INTO compute_usage (id, user_id, workspace_id, node_id, server_type, vcpu_count, started_at, ended_at, credential_source)
        VALUES ('usage-1','owner','ws-child','node','cx22',2,'2026-10-25T08:00:00.000Z','2026-10-25T08:30:00.000Z','platform');
      INSERT INTO pull_requests (project_id, repository, number, url, state, is_draft, title, head_sha, checks_state, checks_updated_at, updated_at, last_synced_at, created_at)
        VALUES ('p','acme/app',7,'https://github.com/acme/app/pull/7','open',0,'Parser','abc123','failure','2026-10-25T09:10:00.000Z','2026-10-25T09:10:00.000Z','2099-01-01T00:00:00.000Z','2026-10-25T08:00:00.000Z');
    `);
    mocks.sessions.mockImplementation(async (_env, projectId: string, taskIds: string[]) =>
      projectId !== 'p'
        ? []
        : taskIds
            .filter((id) => id === 'root' || id === 'child')
            .map((id) => ({
              id: `chat-${id}`,
              taskId: id,
              status: 'active',
              createdByUserId: 'owner',
              lastMessageAt: 1_761_400_000_000,
              attention:
                id === 'child'
                  ? {
                      markerId: 'marker-1',
                      kind: 'needs_input',
                      createdAt: 1_761_400_000_000,
                      reason: 'Merge now or wait for review?',
                      options: ['merge', 'wait'],
                    }
                  : null,
            }))
    );
    mocks.limits.mockResolvedValue({
      credentials: [
        {
          credentialReference: 'cc_credentials:1',
          credentialId: '1',
          credentialSource: 'user',
          provider: 'anthropic',
          providerMode: 'oauth',
          agentType: 'claude-code',
          level: 'warning',
          observedAt: 1_761_400_000_000,
          windows: [
            {
              windowType: 'claude.five_hour',
              provider: 'anthropic',
              source: 'claude-acp.rate_limit',
              status: 'allowed_warning',
              level: 'warning',
              utilizationPercent: 81,
              limitAmount: null,
              remainingAmount: null,
              windowMinutes: 300,
              resetsAt: 1_761_410_000_000,
              observedAt: 1_761_400_000_000,
              updatedAt: 1_761_400_000_000,
            },
          ],
        },
      ],
      generatedAt: 1_761_400_000_000,
    });
    mocks.tokens.mockResolvedValue({ inputTokens: 1200, outputTokens: 300 });
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => {
    sqlite.close();
    vi.mocked(getConnectorReadLimits).mockReset();
  });

  async function caps(maxTasks: number, maxDepth: number) {
    const actual = await vi
      .importActual<typeof import('../../../src/services/connector-read-settings')>(
        '../../../src/services/connector-read-settings'
      )
      .then((module) => module.getConnectorReadLimits(env));
    vi.mocked(getConnectorReadLimits).mockResolvedValue({
      ...actual,
      teamMaxTasks: maxTasks,
      teamMaxDepth: maxDepth,
    });
  }

  it('reads a task and its subtasks from this project only, labelled by relation', async () => {
    const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

    expect(team.tasks.map((row) => [row.taskId, row.depth, row.relation])).toEqual([
      ['root', 0, 'root'],
      ['child', 1, 'subtask'],
      ['retry', 1, 'retry_or_fork'],
      ['grandchild', 2, 'subtask'],
      ['great', 3, 'subtask'],
    ]);
    expect(team.tasks.map((row) => row.taskId)).not.toContain('foreign-child');
    expect(team).toMatchObject({ truncated: false, rootTaskId: 'root' });
  });

  it('bounds depth and size, and says what it left out', async () => {
    await caps(3, 2);

    const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

    expect(team.tasks.map((row) => row.taskId)).toEqual(['root', 'child', 'retry']);
    expect(team.truncated).toBe(true);
    expect(team.omitted).toContain('sam_team_status');
  });

  it('reports state, waits, questions, pull request, evidence and measured usage with sources', async () => {
    const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });
    const child = team.tasks.find((row) => row.taskId === 'child')!;

    expect(child).toMatchObject({
      activity: 'working',
      waitingOn: ['person', 'provider_limit_reset'],
      providerLimit: { resetsAt: '2026-10-25T12:00:00.000Z', source: 'provider_reported' },
      attention: { markerId: 'marker-1', kind: 'needs_input', options: ['merge', 'wait'] },
      chat: { sessionId: 'chat-child', status: 'active' },
      agent: { agentType: 'claude-code', providerMode: 'sam', credentialSource: 'platform' },
      pullRequest: {
        url: 'https://github.com/acme/app/pull/7',
        state: 'open',
        checks: 'failure',
        headSha: 'abc123',
        checksUpdatedAt: '2026-10-25T09:10:00.000Z',
        source: 'github_webhook',
      },
      output: { source: 'agent_reported_not_verified' },
      compute: { runtimeMinutes: 30, vcpuMinutes: 60, runningNow: false },
    });
    expect(child.output.summary.text).toContain('Implemented the parser');
    expect(team.tasks.find((row) => row.taskId === 'retry')?.error).toMatchObject({
      category: 'provider_limit',
    });
    expect(JSON.stringify(team)).not.toContain('Rate limit exceeded on provider');
    expect(team.counts).toMatchObject({
      waitingOnPerson: 1,
      openPullRequests: 1,
      failingChecks: 1,
    });
    expect(team.usage).toMatchObject({
      tokens: { perTask: 'unavailable' },
      samAiProxy: {
        tasksMeteredBySam: 1,
        daily: { inputTokens: 1200, outputTokens: 300, source: 'sam_ai_proxy_meter' },
      },
      subscriptionLimits: [
        {
          provider: 'anthropic',
          windows: [{ windowType: 'claude.five_hour', utilizationPercent: 81 }],
          source: 'provider_reported_last_observed',
        },
      ],
      compute: { runtimeMinutes: 30, cost: 'not_attributed_per_task' },
    });
    expect(team.deployments).toMatchObject({ deployedCommit: 'not_recorded' });
  });

  it('shows the question text only to the person who started the chat', async () => {
    const owner = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });
    const viewer = await samTeamStatus.run(ctx('viewer'), { projectId: 'p', taskId: 'root' });

    const ownerQuestion = owner.tasks.find((row) => row.taskId === 'child')?.attention;
    const viewerQuestion = viewer.tasks.find((row) => row.taskId === 'child')?.attention;
    expect(JSON.stringify(ownerQuestion)).toContain('Merge now or wait for review?');
    expect(viewerQuestion).toMatchObject({ markerId: 'marker-1', kind: 'needs_input' });
    expect(JSON.stringify(viewerQuestion)).not.toContain('Merge now');
  });

  it('marks a failing source unavailable instead of failing the read', async () => {
    mocks.sessions.mockRejectedValue(new Error('object overloaded'));

    const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

    expect(team.tasks).toHaveLength(5);
    expect(team.sources.sessions).toBe('unavailable');
    expect(team.tasks[0]?.chat).toMatchObject({ sessionId: 'chat-root', status: 'unknown' });
  });

  it('resolves a chat to its task and a channel to its roster, in this project only', async () => {
    const byChat = await samTeamStatus.run(ctx(), { projectId: 'p', sessionId: 'chat-child' });
    expect(byChat.tasks.map((row) => row.taskId)).toEqual(['child', 'grandchild', 'great']);
    await expect(
      samTeamStatus.run(ctx(), { projectId: 'p', sessionId: 'chat-missing' })
    ).rejects.toMatchObject({ code: 'not_found' });

    const byChannel = await samTeamStatus.run(ctx(), {
      projectId: 'p',
      channel: 'feature.launch',
    });
    expect(byChannel.tasks.map((row) => row.taskId).sort()).toEqual(['child', 'root']);
    expect(byChannel.tasks.every((row) => row.relation !== 'root')).toBe(true);
  });

  describe('response size', () => {
    /** Subtasks of root with agent text far longer than one response can carry for all of them. */
    function insertWordyTeam(count: number): void {
      for (let index = 0; index < count; index += 1) {
        insertTask(
          task(`wordy-${String(index).padStart(2, '0')}`, {
            parent_task_id: 'root',
            // Multi-byte text with quotes: the budget is in bytes, and the text copy escapes quotes.
            output_summary: 'Résumé ✓ "ok" '.repeat(200),
            completion_evidence: 'Évidence ✓ {"tests": "pass"} '.repeat(100),
            updated_at: `2026-10-25T07:${String(index).padStart(2, '0')}:00.000Z`,
          })
        );
      }
    }

    function respond(maxBytes: number): void {
      (env as unknown as Record<string, unknown>).CONNECTOR_RESPONSE_MAX_BYTES = String(maxBytes);
    }

    /** What `routes/connector-mcp.ts` measures: the result as structured content and as text. */
    function envelopeBytes(result: unknown): number {
      const structuredContent = {
        data: result,
        link: 'https://app.example.test/projects/p',
        untrustedContent: true,
      };
      const response = {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
      return new TextEncoder().encode(JSON.stringify(response)).length;
    }

    it('lists a default-size team without agent text in full at the default cap', async () => {
      // 40 tasks, the default teamMaxTasks: the fixture's five and 35 more without agent text.
      for (let index = 0; index < 35; index += 1) {
        insertTask(task(`quiet-${String(index).padStart(2, '0')}`, { parent_task_id: 'root' }));
      }

      const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

      expect(team.counts).toMatchObject({ tasks: 40, listed: 40 });
      expect(team.truncated).toBe(false);
      expect(team).not.toHaveProperty('agentTextShortenedTo');
      expect(team.tasks.find((row) => row.taskId === 'quiet-00')?.output).toMatchObject({
        summary: null,
        evidence: null,
      });
      expect(envelopeBytes(team)).toBeLessThanOrEqual(120_000);
    });

    it('shortens agent text when that lists every task, and says so', async () => {
      insertWordyTeam(6);
      respond(SHORTEN_CAP);

      const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

      expect(envelopeBytes(team)).toBeLessThanOrEqual(SHORTEN_CAP);
      expect(team.agentTextShortenedTo).toBeLessThan(600);
      expect(team.counts).toMatchObject({ tasks: 11, listed: 11 });
      expect(team.truncated).toBe(false);
      expect(team).not.toHaveProperty('omitted');
      const wordy = team.tasks.find((row) => row.taskId === 'wordy-00')!;
      expect(wordy.output.summary?.text).toContain('sam_task_get');
    });

    it('keeps agent text whole when shortening it would not list another task', async () => {
      // The next task in rank is too large to list at any text length.
      sqlite
        .prepare("UPDATE tasks SET output_summary = ? WHERE id = 'root'")
        .run('Root summary. '.repeat(40));
      sqlite.prepare("UPDATE tasks SET title = ? WHERE id = 'child'").run('t'.repeat(30_000));
      respond(40_000);

      const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

      expect(team.tasks.map((row) => row.taskId)).toEqual(['root']);
      expect(team).not.toHaveProperty('agentTextShortenedTo');
      expect(team.tasks[0]?.output.summary?.truncated).toBe(false);
      expect(team.omitted).toContain('4 of the tasks read are not listed');
      expect(envelopeBytes(team)).toBeLessThanOrEqual(40_000);
    });

    it('lists fewer tasks when even the shortest text does not fit, and says which and why', async () => {
      insertWordyTeam(30);
      respond(30_000);

      const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

      expect(envelopeBytes(team)).toBeLessThanOrEqual(30_000);
      expect(team.agentTextShortenedTo).toBe(100);
      // Counts and usage still cover every task read.
      expect(team.counts.tasks).toBe(35);
      expect(team.counts.listed).toBe(team.tasks.length);
      expect(team.tasks.length).toBeGreaterThan(0);
      expect(team.tasks.length).toBeLessThan(35);
      // The lowest-ranked tasks go first: the root and its first level stay.
      expect(team.tasks[0]?.taskId).toBe('root');
      expect(team.truncated).toBe(true);
      expect(team.omitted).toContain(`${35 - team.tasks.length} of the tasks read are not listed`);
      expect(team.omitted).toContain('sam_task_get');
    });

    it('keeps full agent text for a team that fits', async () => {
      const team = await samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root' });

      expect(team).not.toHaveProperty('agentTextShortenedTo');
      expect(team.counts).toMatchObject({ tasks: 5, listed: 5 });
      expect(team).not.toHaveProperty('omitted');
      expect(responseBytes(team)).toBeLessThanOrEqual(resultByteBudget(env));
    });
  });

  it('requires project membership and exactly one scope', async () => {
    // Non-members get the same non-disclosing answer as for a project that does not exist.
    await expect(
      samTeamStatus.run(ctx('outsider'), { projectId: 'p', taskId: 'root' })
    ).rejects.toMatchObject({ code: 'not_found' });
    // A foreign task id addressed through our project is not found, not leaked.
    await expect(
      samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'foreign-child' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      samTeamStatus.run(ctx(), { projectId: 'p', taskId: 'root', channel: 'feature.launch' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
