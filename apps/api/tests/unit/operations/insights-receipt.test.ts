/**
 * runReceipt against a real SQL engine (rules 11 and 28). Every read binds the project, so a
 * foreign project's rows are seeded beside the owner's with colliding identifiers and must never
 * reach the receipt. The ProjectData facts are an external Durable Object boundary and are mocked
 * at the service seam the port calls.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { OperationError, runReceipt } from '@simple-agent-manager/operations';
import type { RunReceiptFacts } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ facts: vi.fn() }));
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getRunReceiptFacts: mocks.facts,
}));

const MIN = 60_000;
const T0 = Date.parse('2026-11-15T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function facts(overrides: Partial<RunReceiptFacts> = {}): RunReceiptFacts {
  return {
    sessionFound: true,
    messagesArchived: false,
    acpSessionIds: ['acp-1'],
    toolCalls: {
      byKind: [
        { kind: 'execute', count: 74 },
        { kind: 'read', count: 61 },
        { kind: 'edit', count: 39 },
      ],
      total: 174,
      examinedMessages: 400,
      scanLimited: false,
    },
    waitingIntervals: [
      { startMs: T0 + 10 * MIN, endMs: T0 + 15 * MIN, reason: 'Use exponential backoff?' },
    ],
    waitingLimited: false,
    lastAgentMessageAt: T0 + 30 * MIN,
    lastMessageAt: T0 + 30 * MIN,
    ...overrides,
  };
}

describe('runReceipt', () => {
  let sqlite: Database.Database;
  let env: Env;
  let statements: number;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    };
  }

  function insert(table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  function event(taskId: string, from: string | null, to: string, at: number): void {
    insert('task_status_events', {
      id: `${taskId}-${to}`,
      task_id: taskId,
      from_status: from,
      to_status: to,
      actor_type: 'system',
      created_at: iso(at),
    });
  }

  /**
   * A finished run: created T0, placed T0+1m, agent started T0+4m, agent's last message T0+30m,
   * checks finished T0+38m, completed T0+40m. One question from T0+10m to T0+15m.
   */
  function seedRun(
    projectId: string,
    id: string,
    fields: Record<string, string | number | null> = {}
  ) {
    insert('workspaces', {
      id: `ws-${id}`,
      project_id: projectId,
      user_id: 'owner',
      name: `ws-${id}`,
      status: 'stopped',
      vm_size: 'small',
      chat_session_id: `chat-${id}`,
      creating_started_at: iso(T0 + MIN),
      resolved_reservation_json: JSON.stringify({
        version: 1,
        cpuMillis: 2000,
        memoryMb: 4096,
        diskMb: 10_240,
        exclusiveNode: false,
        source: 'platform',
        sourceId: 'platform',
      }),
    });
    insert('tasks', {
      id,
      project_id: projectId,
      user_id: 'owner',
      created_by: 'owner',
      title: `Run ${id}`,
      status: 'completed',
      workspace_id: `ws-${id}`,
      chat_session_id: `chat-${id}`,
      skill_id: null,
      output_pr_url: `https://github.com/acme/${projectId === 'p' ? 'app' : 'other'}/pull/2771`,
      created_at: iso(T0),
      started_at: iso(T0 + 4 * MIN),
      completed_at: iso(T0 + 40 * MIN),
      updated_at: iso(T0 + 40 * MIN),
      ...fields,
    });
    event(id, null, 'queued', T0);
    event(id, 'queued', 'delegated', T0 + 2 * MIN);
    event(id, 'delegated', 'in_progress', T0 + 4 * MIN);
    event(id, 'in_progress', 'completed', T0 + 40 * MIN);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/app');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('teammate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','teammate','member','active'), ('foreign','outsider','owner','active');
    `);
    // Inserted first so an unscoped lookup by repository and number would find it first.
    insert('pull_requests', {
      id: 'pr-foreign',
      project_id: 'foreign',
      repository: 'acme/app',
      number: 2771,
      url: 'https://github.com/acme/app/pull/2771',
      title: 'FOREIGN PR',
      state: 'closed',
      head_sha: 'b'.repeat(40),
      checks_state: 'failure',
      created_at: iso(T0),
      updated_at: iso(T0),
    });
    seedRun('p', 'task-own');
    insert('pull_requests', {
      id: 'pr-own',
      project_id: 'p',
      repository: 'acme/app',
      number: 2771,
      url: 'https://github.com/acme/app/pull/2771',
      title: 'Add retry budget',
      state: 'merged',
      head_sha: 'a'.repeat(40),
      merged_at: iso(T0 + 39 * MIN),
      checks_state: 'success',
      created_at: iso(T0 + 20 * MIN),
      updated_at: iso(T0 + 39 * MIN),
    });
    for (const [key, at] of [
      ['lint', T0 + 33 * MIN],
      ['test', T0 + 38 * MIN],
    ] as const) {
      insert('pull_request_checks', {
        project_id: 'p',
        repository: 'acme/app',
        head_sha: 'a'.repeat(40),
        check_key: key,
        state: 'success',
        updated_at: iso(at),
      });
    }
    insert('workspace_resource_summaries', {
      id: 'res-own',
      project_id: 'p',
      workspace_id: 'ws-task-own',
      task_id: 'task-own',
      source_version: 1,
      started_at: T0,
      ended_at: T0 + 40 * MIN,
      sample_count: 400,
      cpu_peak_millis: 1800,
      memory_peak_bytes: 3_100_000_000,
      oom_count: 0,
      completeness_json: '{}',
      summary_json: '{}',
      created_at: T0,
      updated_at: T0,
    });
    insert('cc_credentials', {
      id: 'cred-own',
      owner_id: 'owner',
      name: 'Personal Max',
      kind: 'api-key',
      encrypted_token: 'x',
      iv: 'y',
      created_at: iso(T0),
      updated_at: iso(T0),
    });
    insert('agent_sessions', {
      id: 'acp-1',
      workspace_id: 'ws-task-own',
      user_id: 'owner',
      agent_type: 'claude-code',
      agent_credential_source: 'user',
      agent_credential_scope: 'profile',
      agent_credential_reference: 'cc_credentials:cred-own',
      created_at: iso(T0 + 3 * MIN),
      updated_at: iso(T0 + 3 * MIN),
    });

    // Foreign project rows that collide with the owner's identifiers where the schema allows.
    seedRun('foreign', 'task-foreign');
    insert('workspace_resource_summaries', {
      id: 'res-foreign',
      project_id: 'foreign',
      workspace_id: 'ws-task-foreign',
      task_id: 'task-own',
      source_version: 1,
      started_at: T0,
      ended_at: T0,
      sample_count: 1,
      memory_peak_bytes: 99_000_000_000,
      oom_count: 7,
      completeness_json: '{}',
      summary_json: '{}',
      created_at: T0,
      updated_at: T0,
    });
    insert('asks', {
      id: 'ask-foreign',
      project_id: 'foreign',
      kind: 'question',
      title: 'FOREIGN QUESTION',
      source_session_id: 'chat-task-own',
      created_at: T0 + 5 * MIN,
      updated_at: T0 + 5 * MIN,
      resolved_at: T0 + 35 * MIN,
    });

    mocks.facts.mockResolvedValue(facts());
    const d1 = createSqliteD1(sqlite);
    statements = 0;
    const counted = {
      ...d1,
      prepare(query: string) {
        const statement = d1.prepare(query);
        const wrap = (bound: typeof statement): typeof statement =>
          new Proxy(bound, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (prop === 'bind') return (...args: unknown[]) => wrap(value.apply(target, args));
              if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw')
                return (...args: unknown[]) => {
                  statements += 1;
                  return value.apply(target, args);
                };
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        return wrap(statement);
      },
    };
    env = { DATABASE: counted, BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('measures phases, outcome, account, resources and tool calls for the owner', async () => {
    const receipt = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });

    expect(receipt.phases).toEqual([
      { key: 'machine', durationMs: 1 * MIN },
      { key: 'setup', durationMs: 3 * MIN },
      // Agent window 4m → 40m, less 5m waiting and 8m of CI (last agent message at 30m, last
      // check at 38m).
      { key: 'agent', durationMs: 36 * MIN - 5 * MIN - 8 * MIN },
      { key: 'waiting', durationMs: 5 * MIN },
      { key: 'ci', durationMs: 8 * MIN },
    ]);
    expect(receipt.totalMs).toBe(40 * MIN);
    expect(receipt.outcome).toEqual({
      pullRequest: {
        number: 2771,
        url: 'https://github.com/acme/app/pull/2771',
        title: 'Add retry budget',
        repository: 'acme/app',
        state: 'merged',
        mergedAt: iso(T0 + 39 * MIN),
      },
      checks: 'success',
      ciFirstTry: 'not_recorded',
      terminalReason: null,
    });
    expect(receipt.account).toEqual({
      agentType: 'claude-code',
      credentialSource: 'user',
      credentialScope: 'profile',
      accountName: 'Personal Max',
      isOwnSession: true,
    });
    expect(receipt.resources).toEqual({
      measured: true,
      peakMemoryBytes: 3_100_000_000,
      requestedMemoryMb: 4096,
      peakCpuMillis: 1800,
      requestedCpuMillis: 2000,
      oomKills: 0,
    });
    expect(receipt.toolCalls).toEqual({
      total: 174,
      byKind: facts().toolCalls.byKind,
      scanLimited: false,
    });
    expect(receipt.tokens).toEqual({ state: 'not_reported' });
    expect(receipt.unavailable).toEqual([]);
    expect(mocks.facts).toHaveBeenCalledWith(expect.anything(), 'p', {
      sessionId: 'chat-task-own',
      fromMs: T0 + 4 * MIN,
      toMs: T0 + 40 * MIN,
      messageScanMaxRows: 10_000,
      waitingMaxIntervals: 200,
    });
  });

  it('answers a foreign task exactly like a missing one, while the owner reads their own', async () => {
    const outcome = async (taskId: string) =>
      runReceipt(ctx(), { projectId: 'p', taskId }).then(
        () => 'ok',
        (error: unknown) =>
          error instanceof OperationError ? `${error.code}:${error.message}` : String(error)
      );
    expect(await outcome('task-own')).toBe('ok');
    expect(await outcome('task-foreign')).toBe('not_found:Task not found');
    expect(await outcome('task-missing')).toBe('not_found:Task not found');
    expect(mocks.facts).toHaveBeenCalledTimes(1);
  });

  it('refuses a project the caller is not a member of', async () => {
    await expect(
      runReceipt(ctx(), { projectId: 'foreign', taskId: 'task-foreign' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      runReceipt(ctx('outsider'), { projectId: 'p', taskId: 'task-own' })
    ).rejects.toBeInstanceOf(OperationError);
  });

  it('never reads a foreign project’s pull request, resources or asks with colliding keys', async () => {
    const receipt = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(receipt.outcome.pullRequest?.title).toBe('Add retry budget');
    expect(receipt.outcome.checks).toBe('success');
    expect(receipt.resources.oomKills).toBe(0);
    expect(receipt.resources.peakMemoryBytes).toBe(3_100_000_000);
    expect(receipt.phases.find((phase) => phase.key === 'waiting')?.durationMs).toBe(5 * MIN);
    expect(JSON.stringify(receipt)).not.toContain('FOREIGN');
  });

  it('hides the account name from a teammate but keeps the account kind', async () => {
    const receipt = await runReceipt(ctx('teammate'), { projectId: 'p', taskId: 'task-own' });
    expect(receipt.account).toMatchObject({
      accountName: null,
      isOwnSession: false,
      credentialSource: 'user',
      credentialScope: 'profile',
    });
  });

  it('counts an ask’s waiting time for everyone but shows its title only to its assignee', async () => {
    mocks.facts.mockResolvedValue(facts({ waitingIntervals: [] }));
    insert('asks', {
      id: 'ask-private',
      project_id: 'p',
      kind: 'question',
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      title: 'Approve the refund for the private customer?',
      source_session_id: 'chat-task-own',
      source_task_id: 'task-own',
      created_at: T0 + 10 * MIN,
      updated_at: T0 + 10 * MIN,
      resolved_at: T0 + 22 * MIN,
      status: 'answered',
    });
    const waitingOf = (r: Awaited<ReturnType<typeof runReceipt>>) =>
      r.phases.find((phase) => phase.key === 'waiting')?.durationMs;

    const teammate = await runReceipt(ctx('teammate'), { projectId: 'p', taskId: 'task-own' });
    expect(waitingOf(teammate)).toBe(12 * MIN);
    expect(teammate.slowedDown.find((item) => item.kind === 'waiting')).toMatchObject({
      durationMs: 12 * MIN,
      question: null,
    });
    expect(JSON.stringify(teammate)).not.toContain('private customer');

    // Owner control: the assignee sees the question.
    const owner = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(owner.slowedDown.find((item) => item.kind === 'waiting')?.question).toBe(
      'Approve the refund for the private customer?'
    );
  });

  it('degrades malformed rows and a failed facts read to missing parts, not a failure', async () => {
    sqlite.exec(`
      UPDATE workspaces SET resolved_reservation_json = '{not json' WHERE id = 'ws-task-own';
      UPDATE tasks SET resolved_reservation_json = NULL WHERE id = 'task-own';
      UPDATE pull_requests SET url = 'javascript:alert(1)' WHERE id = 'pr-own';
    `);
    mocks.facts.mockRejectedValue(new Error('object reset'));
    const receipt = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(receipt.resources.requestedMemoryMb).toBeNull();
    expect(receipt.outcome.pullRequest).toBeNull();
    expect(receipt.toolCalls).toBeNull();
    expect(receipt.unavailable).toEqual(['toolCalls']);
    // Liveness: the parts that did read are still there.
    expect(receipt.phases.find((phase) => phase.key === 'setup')?.durationMs).toBe(3 * MIN);
    expect(receipt.resources.peakMemoryBytes).toBe(3_100_000_000);
  });

  it('lists a setup slower than the usual for the same skill, and not one within it', async () => {
    sqlite.exec(`INSERT INTO skills (id, project_id, user_id, name, created_at, updated_at)
      VALUES ('skill-do', 'p', 'owner', 'do', '${iso(T0)}', '${iso(T0)}')`);
    sqlite.exec(`UPDATE tasks SET skill_id = 'skill-do' WHERE id = 'task-own'`);
    for (let i = 0; i < 4; i += 1) {
      seedRun('p', `past-${i}`, { skill_id: 'skill-do', created_at: iso(T0 - (i + 1) * 60 * MIN) });
      // Past runs: placed after 1m (workspace), started 1m after placement.
      sqlite.exec(`UPDATE task_status_events SET created_at = '${iso(T0 - (i + 1) * 60 * MIN + 2 * MIN)}'
        WHERE task_id = 'past-${i}' AND to_status = 'in_progress'`);
      sqlite.exec(`UPDATE workspaces SET creating_started_at = '${iso(T0 - (i + 1) * 60 * MIN + MIN)}'
        WHERE id = 'ws-past-${i}'`);
    }
    const slow = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(slow.slowedDown[0]).toMatchObject({
      kind: 'waiting',
      durationMs: 5 * MIN,
      question: 'Use exponential backoff?',
    });
    expect(slow.slowedDown).toContainEqual(
      expect.objectContaining({
        kind: 'setup',
        durationMs: 3 * MIN,
        usualMs: MIN,
        comparedBy: 'skill',
        sampleSize: 4,
      })
    );

    // Control: the same history with a setup inside the usual range lists no setup item.
    sqlite.exec(`UPDATE task_status_events SET created_at = '${iso(T0 + 2 * MIN)}'
      WHERE task_id = 'task-own' AND to_status = 'in_progress'`);
    const usual = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(usual.slowedDown.map((item) => item.kind)).not.toContain('setup');
    expect(usual.slowedDown.map((item) => item.kind)).toContain('waiting');
  });

  it('marks the waiting phase as a floor when the question cap was reached', async () => {
    mocks.facts.mockResolvedValue(facts({ waitingLimited: true }));
    const receipt = await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(receipt.phases.find((phase) => phase.key === 'waiting')).toMatchObject({
      durationMs: 5 * MIN,
      limited: true,
    });
    // Control: other phases are not marked.
    expect(receipt.phases.find((phase) => phase.key === 'setup')?.limited).toBeUndefined();
  });

  it('stays within the receipt I/O budget of 8 round trips', async () => {
    await runReceipt(ctx(), { projectId: 'p', taskId: 'task-own' });
    expect(statements + mocks.facts.mock.calls.length).toBeLessThanOrEqual(8);
  });
});
