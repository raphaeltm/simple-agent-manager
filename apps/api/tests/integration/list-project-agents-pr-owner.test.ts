/**
 * Vertical slice for the PR Shepherd's owner check: `list_project_agents` with
 * `prHeadBranch`/`prUrl`, driven through the real MCP JSON-RPC route and the real
 * `listAgentActivityTasks` SQL over an in-memory SQLite database. Only KV (token +
 * rate limit) is in memory; nothing on the query path is mocked.
 *
 * Production shapes this reproduces (idea 01M496QHP8MY2S8W3F2BJPV2XN):
 * - #2279/#2276: the original owner, sleeping, linked by `output_branch`.
 * - #2243: an in-flight completion task whose `output_branch` is its own generated
 *   name and whose workspace checked out the PR head. Only `workspaces.branch`
 *   links it to the PR.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { Env } from '../../src/env';
import { listAgentActivityTasks } from '../../src/services/agent-activity';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';
const HEAD = 'sam/cut-production-error-noise-t83azb';
const PR_URL = 'https://github.com/acme/repo/pull/2279';
const MCP_TOKEN = 'shepherd-token';
const CALLER_TASK = 'shepherd-task';

const ACTIVE_STATUSES = ['queued', 'delegated', 'in_progress', 'sleeping'] as const;
const INACTIVE_STATUSES = ['completed', 'failed', 'cancelled', 'ready', 'draft'] as const;

interface TaskFixture {
  id: string;
  status: string;
  projectId?: string;
  outputBranch?: string | null;
  outputPrUrl?: string | null;
  workspaceId?: string | null;
  supersededByTaskId?: string | null;
  createdAt?: string;
}

interface AgentEntry {
  taskId: string;
  status: string;
  branch: string | null;
  workspaceBranch: string | null;
  outputPrUrl: string | null;
}

interface ListResult {
  totalAgents: number;
  agents: AgentEntry[];
  filter?: { prHeadBranch?: string; prUrl?: string };
}

/** Handles both KV read forms the route uses: `'json'` and `{ type: 'json' }`. */
function createTestKv(): KVNamespace {
  const values = new Map<string, string>();
  const wantsJson = (type: unknown) =>
    type === 'json' || (typeof type === 'object' && type !== null && 'type' in type);
  return {
    get: async (key: string, type?: unknown) => {
      const value = values.get(key) ?? null;
      return value !== null && wantsJson(type) ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}

describe('list_project_agents pull request owner filter', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono;
  let sequence = 0;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.tasks,
      schema.workspaces,
      schema.sessionSnapshots,
    ]);
    for (const id of [PROJECT, OTHER_PROJECT]) {
      sqlite.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, id);
    }
    const kv = createTestKv();
    await kv.put(
      `mcp:${MCP_TOKEN}`,
      JSON.stringify({
        taskId: CALLER_TASK,
        projectId: PROJECT,
        userId: 'user-1',
        workspaceId: 'ws-shepherd',
        createdAt: new Date().toISOString(),
      })
    );
    env = { DATABASE: createSqliteD1(sqlite), KV: kv } as unknown as Env;
    const { mcpRoutes } = await import('../../src/routes/mcp');
    app = new Hono();
    app.route('/mcp', mcpRoutes);
    sequence = 0;
    insertTask({ id: CALLER_TASK, status: 'in_progress', outputBranch: 'sam/shepherd-run' });
  });

  afterEach(() => sqlite.close());

  function insertTask(task: TaskFixture): void {
    sequence += 1;
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, priority, output_branch,
           output_pr_url, workspace_id, superseded_by_task_id, created_at)
         VALUES (?, ?, 'user-1', ?, ?, 0, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.projectId ?? PROJECT,
        `Task ${task.id}`,
        task.status,
        task.outputBranch ?? null,
        task.outputPrUrl ?? null,
        task.workspaceId ?? null,
        task.supersededByTaskId ?? null,
        task.createdAt ?? new Date(Date.UTC(2026, 9, 11, 0, sequence)).toISOString()
      );
  }

  function insertWorkspace(id: string, branch: string, projectId = PROJECT): void {
    sqlite
      .prepare(
        "INSERT INTO workspaces (id, project_id, user_id, branch, status) VALUES (?, ?, 'user-1', ?, 'running')"
      )
      .run(id, projectId, branch);
  }

  async function callListProjectAgents(args: Record<string, unknown>) {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MCP_TOKEN}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'list_project_agents', arguments: args },
        }),
      },
      env
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      result?: { content: Array<{ text: string }> };
      error?: { code: number; message: string };
    };
  }

  async function listAgents(args: Record<string, unknown>): Promise<ListResult> {
    const body = await callListProjectAgents(args);
    expect(body.error).toBeUndefined();
    return JSON.parse(body.result?.content[0]?.text ?? '{}') as ListResult;
  }

  async function ownerIds(args: Record<string, unknown>): Promise<string[]> {
    const result = await listAgents(args);
    return result.agents.map((agent) => agent.taskId).sort();
  }

  /** One owner per link, each matching through that link alone. */
  function seedOneOwnerPerLink(): void {
    // The task that opened the PR (#2279/#2276 shape).
    insertTask({ id: 'owner-output-branch', status: 'sleeping', outputBranch: HEAD });
    // An in-flight completion task dispatched with branch=<head> (#2243 shape).
    insertWorkspace('ws-completion', HEAD);
    insertTask({
      id: 'owner-workspace-branch',
      status: 'in_progress',
      outputBranch: 'sam/complete-pr-2279-x0btnm',
      workspaceId: 'ws-completion',
    });
    // A conversation task that reported the PR through complete_task.
    insertWorkspace('ws-conversation', 'sam/conversation-qwe123');
    insertTask({
      id: 'owner-pr-url',
      status: 'sleeping',
      outputBranch: 'sam/conversation-qwe123',
      outputPrUrl: PR_URL,
      workspaceId: 'ws-conversation',
    });
    // Active, but working on something else: the liveness control.
    insertWorkspace('ws-unrelated', 'sam/unrelated-work');
    insertTask({
      id: 'unrelated-active',
      status: 'in_progress',
      outputBranch: 'sam/unrelated-work',
      outputPrUrl: 'https://github.com/acme/repo/pull/9999',
      workspaceId: 'ws-unrelated',
    });
  }

  it('returns exactly the owners linked by output branch, workspace branch or PR URL', async () => {
    seedOneOwnerPerLink();

    const result = await listAgents({ prHeadBranch: HEAD, prUrl: PR_URL });

    expect(result.agents.map((agent) => agent.taskId).sort()).toEqual([
      'owner-output-branch',
      'owner-pr-url',
      'owner-workspace-branch',
    ]);
    expect(result.totalAgents).toBe(3);
    expect(result.filter).toEqual({ prHeadBranch: HEAD, prUrl: PR_URL });
    expect(result.agents.find((agent) => agent.taskId === 'owner-workspace-branch')).toMatchObject({
      branch: 'sam/complete-pr-2279-x0btnm',
      workspaceBranch: HEAD,
      outputPrUrl: null,
    });
  });

  it('finds the #2243 completion-task shape through the workspace branch alone', async () => {
    seedOneOwnerPerLink();

    expect(await ownerIds({ prHeadBranch: HEAD })).toEqual([
      'owner-output-branch',
      'owner-workspace-branch',
    ]);
  });

  it('finds an owner through the PR URL alone and ignores branch-only owners', async () => {
    seedOneOwnerPerLink();

    expect(await ownerIds({ prUrl: PR_URL })).toEqual(['owner-pr-url']);
    // A trailing slash on the caller's URL still matches the canonical stored value.
    expect(await ownerIds({ prUrl: `${PR_URL}/` })).toEqual(['owner-pr-url']);
  });

  it.each(ACTIVE_STATUSES)('treats a %s task on the head branch as an owner', async (status) => {
    insertTask({ id: `owner-${status}`, status, outputBranch: HEAD });

    expect(await ownerIds({ prHeadBranch: HEAD, prUrl: PR_URL })).toEqual([`owner-${status}`]);
  });

  it.each(INACTIVE_STATUSES)('never treats a %s task as an owner', async (status) => {
    insertWorkspace(`ws-${status}`, HEAD);
    insertTask({
      id: `inactive-${status}`,
      status,
      outputBranch: HEAD,
      outputPrUrl: PR_URL,
      workspaceId: `ws-${status}`,
    });
    // Liveness: an active owner in the same database is still found.
    insertTask({ id: 'owner-live', status: 'in_progress', outputBranch: HEAD });

    expect(await ownerIds({ prHeadBranch: HEAD, prUrl: PR_URL })).toEqual(['owner-live']);
  });

  it('reports a woken successor, not the superseded predecessor', async () => {
    insertTask({
      id: 'predecessor',
      status: 'in_progress',
      outputBranch: HEAD,
      supersededByTaskId: 'successor',
    });
    insertTask({ id: 'successor', status: 'sleeping', outputBranch: HEAD });

    expect(await ownerIds({ prHeadBranch: HEAD })).toEqual(['successor']);
  });

  it('never reports another project, even through a cross-project workspace row', async () => {
    insertWorkspace('ws-other-project', HEAD, OTHER_PROJECT);
    insertTask({
      id: 'other-project-owner',
      projectId: OTHER_PROJECT,
      status: 'in_progress',
      outputBranch: HEAD,
      outputPrUrl: PR_URL,
      workspaceId: 'ws-other-project',
    });
    // A project-1 task pointing at a project-2 workspace must not inherit its branch.
    insertTask({
      id: 'misjoined-workspace',
      status: 'in_progress',
      outputBranch: 'sam/elsewhere',
      workspaceId: 'ws-other-project',
    });
    insertTask({ id: 'owner-same-project', status: 'sleeping', outputBranch: HEAD });

    expect(await ownerIds({ prHeadBranch: HEAD, prUrl: PR_URL })).toEqual(['owner-same-project']);
  });

  it('excludes the calling task itself', async () => {
    sqlite.prepare('UPDATE tasks SET output_branch = ? WHERE id = ?').run(HEAD, CALLER_TASK);
    insertTask({ id: 'owner-peer', status: 'sleeping', outputBranch: HEAD });

    expect(await ownerIds({ prHeadBranch: HEAD })).toEqual(['owner-peer']);
  });

  it('returns an empty owner list with the filter echoed when nothing owns the PR', async () => {
    seedOneOwnerPerLink();

    const result = await listAgents({
      prHeadBranch: 'dependabot/npm_and_yarn/vitest-4.2.0',
      prUrl: 'https://github.com/acme/repo/pull/1',
    });

    expect(result).toEqual({
      totalAgents: 0,
      agents: [],
      filter: {
        prHeadBranch: 'dependabot/npm_and_yarn/vitest-4.2.0',
        prUrl: 'https://github.com/acme/repo/pull/1',
      },
    });
  });

  it('keeps the unfiltered listing, now with PR URL and workspace branch', async () => {
    seedOneOwnerPerLink();

    for (const args of [{}, { prHeadBranch: null, prUrl: null }]) {
      const result = await listAgents(args);
      expect(result.filter).toBeUndefined();
      expect(result.agents.map((agent) => agent.taskId).sort()).toEqual([
        'owner-output-branch',
        'owner-pr-url',
        'owner-workspace-branch',
        'unrelated-active',
      ]);
      expect(result.agents.find((agent) => agent.taskId === 'unrelated-active')).toEqual(
        expect.objectContaining({
          branch: 'sam/unrelated-work',
          workspaceBranch: 'sam/unrelated-work',
          outputPrUrl: 'https://github.com/acme/repo/pull/9999',
        })
      );
    }
  });

  it('refuses an empty owner filter at the service instead of matching every task', async () => {
    seedOneOwnerPerLink();

    await expect(
      listAgentActivityTasks(env, { projectId: PROJECT, ownsPullRequest: {} })
    ).rejects.toThrow('ownsPullRequest requires a headBranch or url');
    // Control: the same service call with a real link answers normally.
    const rows = await listAgentActivityTasks(env, {
      projectId: PROJECT,
      ownsPullRequest: { url: PR_URL },
    });
    expect(rows.map((row) => row.id)).toEqual(['owner-pr-url']);
  });

  it.each([
    [{ prHeadBranch: '' }, 'prHeadBranch must be a non-empty string'],
    [{ prHeadBranch: '   ' }, 'prHeadBranch must be a non-empty string'],
    [{ prUrl: 2279 }, 'prUrl must be a string'],
    [{ prHeadBranch: HEAD, prUrl: '/' }, 'prUrl must be a non-empty string'],
  ])('rejects a malformed filter %j instead of listing every agent', async (args, message) => {
    seedOneOwnerPerLink();

    const body = await callListProjectAgents(args);

    expect(body.result).toBeUndefined();
    expect(body.error).toMatchObject({ code: -32602, message });
  });
});
