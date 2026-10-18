import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleTaskPullRequestAssociation } from '../../../src/routes/mcp/task-pr-association-tools';
import { listAgentActivityTasks } from '../../../src/services/agent-activity';
import {
  callMcpTool,
  createJsonKv,
  createMcpApp,
  postMcp,
  storeMcpToken,
  toolResult,
} from '../../helpers/mcp-route';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const pr = (n: number) => `https://github.com/owner/repo/pull/${n}`;
function fixture() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec('DROP TABLE task_pull_request_associations');
  applySqliteMigration(
    sqlite,
    new URL('../../../src/db/migrations/0198_task_pull_request_associations.sql', import.meta.url)
  );
  sqlite
    .prepare(
      `INSERT INTO projects (id,user_id,name,repository,repo_provider,status) VALUES ('p','u','Project','owner/repo','github','active')`
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO project_members (project_id,user_id,role,status) VALUES ('p','u','owner','active')"
    )
    .run();
  for (const [id, status] of [
    ['owner', 'in_progress'],
    ['old', 'completed'],
    ['next', 'in_progress'],
    ['research', 'completed'],
  ]) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id,project_id,user_id,title,status,created_at,output_pr_url) VALUES (?,'p','u',?,?, '2026-10-18',?)`
      )
      .run(id, id, status, id === 'old' ? pr(2375) : null);
  }
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const token = {
    taskId: 'owner',
    projectId: 'p',
    userId: 'u',
    workspaceId: 'ws',
    contextType: 'task',
  } as McpTokenData;
  const call = (
    tool: 'associate_pull_request' | 'list_pull_request_associations',
    args: Record<string, unknown>,
    identity = token
  ) =>
    handleTaskPullRequestAssociation(
      tool,
      1,
      tool === 'associate_pull_request' ? { prHeadBranch: 'release-branch', ...args } : args,
      identity,
      env
    );
  const owners = async (url: string) =>
    (await listAgentActivityTasks(env, { projectId: 'p', ownsPullRequest: { url } })).map(
      (t) => t.id
    );
  return { sqlite, env, token, call, owners };
}
const data = (r: Awaited<ReturnType<typeof handleTaskPullRequestAssociation>>) =>
  JSON.parse((r.result as { content: { text: string }[] }).content[0].text);

describe('explicit PR ownership vertical slice', () => {
  it('discovers and calls associations through the authenticated MCP route', async () => {
    const f = fixture();
    f.env.KV = createJsonKv();
    await storeMcpToken(f.env.KV, 'association-test-token', {
      taskId: 'owner',
      projectId: 'p',
      userId: 'u',
      workspaceId: 'ws',
    });
    const app = await createMcpApp();
    const discovery = await postMcp(app, f.env, 'association-test-token', 'tools/list');
    expect(discovery.error).toBeUndefined();
    const tools = (discovery.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toContain('associate_pull_request');
    expect(tools).toContain('list_pull_request_associations');
    const recorded = await callMcpTool(
      app,
      f.env,
      'association-test-token',
      'associate_pull_request',
      {
        prUrl: pr(18),
        prHeadBranch: 'release-18',
        disposition: 'owned',
        reason: 'Assigned through MCP',
      }
    );
    expect(recorded.error).toBeUndefined();
    const owners = toolResult<{ agents: { taskId: string }[] }>(
      await callMcpTool(app, f.env, 'association-test-token', 'list_project_agents', {
        prUrl: pr(18),
      })
    );
    // list_project_agents intentionally excludes its caller. A peer must see the owner.
    expect(owners.agents).toEqual([]);
    await storeMcpToken(f.env.KV, 'peer-token', {
      taskId: 'next',
      projectId: 'p',
      userId: 'u',
      workspaceId: 'ws-next',
    });
    const peers = toolResult<{ agents: { taskId: string }[] }>(
      await callMcpTool(app, f.env, 'peer-token', 'list_project_agents', { prUrl: pr(18) })
    );
    expect(peers.agents.map((a) => a.taskId)).toEqual(['owner']);
    expect(
      (
        await callMcpTool(app, f.env, 'peer-token', 'list_pull_request_associations', {
          prUrl: pr(18),
        })
      ).error
    ).toBeUndefined();
    f.sqlite.close();
  }, 30_000);

  it('associates multiple PRs assigned later, with exact lookups and retained held disposition', async () => {
    const f = fixture();
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(10),
          disposition: 'owned',
          reason: 'Assigned release',
        })
      ).error
    ).toBeUndefined();
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(11),
          disposition: 'held',
          reason: 'Uncertain legacy artifact; preserve',
        })
      ).error
    ).toBeUndefined();
    expect(await f.owners(pr(10))).toEqual(['owner']);
    expect(await f.owners(pr(11))).toEqual(['owner']);
    expect(await f.owners(pr(1))).toEqual([]);
    expect(await f.owners(pr(100))).toEqual([]);
    const rows = data(await f.call('list_pull_request_associations', {})).associations;
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { prUrl: string }) => r.prUrl === pr(11)).disposition).toBe('held');
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(11),
          disposition: 'owned',
          reason: 'Release now',
        })
      ).error
    ).toBeDefined();
    f.sqlite.close();
  });
  it('refuses implicit legacy handoff and active branch/description writers', async () => {
    const f = fixture();
    const args = { prUrl: pr(2375), disposition: 'owned', reason: 'Assigned' };
    expect((await f.call('associate_pull_request', args)).error).toBeDefined();
    for (const column of ['output_branch', 'description']) {
      f.sqlite
        .prepare(`UPDATE tasks SET ${column}=? WHERE id='next'`)
        .run(column === 'output_branch' ? 'release-branch' : `Finish ${pr(16)}`);
      expect(
        (
          await f.call('associate_pull_request', {
            prUrl: pr(16),
            disposition: 'owned',
            reason: 'Assigned',
          })
        ).error
      ).toBeDefined();
      f.sqlite.prepare(`UPDATE tasks SET ${column}=NULL WHERE id='next'`).run();
    }
    f.sqlite.close();
  });

  it('records authorized continuation without reopening the completed predecessor', async () => {
    const f = fixture();
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(2375),
          disposition: 'owned',
          reason: 'User authorized replacement after writer check',
          previousTaskId: 'old',
        })
      ).error
    ).toBeUndefined();
    expect(await f.owners(pr(2375))).toEqual(['owner']);
    const row = data(await f.call('list_pull_request_associations', { prUrl: pr(2375) }))
      .associations[0];
    expect(row.previousTaskId).toBe('old');
    expect(f.sqlite.prepare("SELECT status FROM tasks WHERE id='old'").get()).toEqual({
      status: 'completed',
    });
    expect(f.sqlite.prepare("SELECT status FROM tasks WHERE id='research'").get()).toEqual({
      status: 'completed',
    });
    f.sqlite.close();
  });
  it('fails closed on active competitors, invalid handoffs and held predecessors', async () => {
    const f = fixture();
    await f.call('associate_pull_request', {
      prUrl: pr(12),
      disposition: 'held',
      reason: 'Preserve',
    });
    expect(
      (
        await f.call(
          'associate_pull_request',
          { prUrl: pr(12), disposition: 'owned', reason: 'Take over' },
          { ...f.token, taskId: 'next' }
        )
      ).error
    ).toBeDefined();
    f.sqlite.exec("UPDATE tasks SET status='completed' WHERE id='owner'");
    expect(await f.owners(pr(12))).toEqual([]);
    expect(
      data(
        await f.call(
          'list_pull_request_associations',
          { prUrl: pr(12) },
          { ...f.token, taskId: 'next' }
        )
      ).associations[0].disposition
    ).toBe('held');
    expect(
      (
        await f.call(
          'associate_pull_request',
          { prUrl: pr(12), disposition: 'owned', reason: 'Replace', previousTaskId: 'owner' },
          { ...f.token, taskId: 'next' }
        )
      ).error
    ).toBeDefined();
    expect(
      (
        await f.call(
          'associate_pull_request',
          { prUrl: pr(999), disposition: 'owned', reason: 'Replace', previousTaskId: 'old' },
          { ...f.token, taskId: 'next' }
        )
      ).error
    ).toBeDefined();
    f.sqlite.close();
  });
  it('serializes competing claims and requires explicit predecessor evidence for later continuation', async () => {
    const f = fixture();
    const args = { prUrl: pr(15), disposition: 'owned', reason: 'Assigned' };
    const results = await Promise.all([
      f.call('associate_pull_request', args),
      f.call('associate_pull_request', args, { ...f.token, taskId: 'next' }),
    ]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    const winner = (await f.owners(pr(15)))[0]!;
    expect(await f.owners(pr(15))).toHaveLength(1);
    const loser = winner === 'owner' ? 'next' : 'owner';
    f.sqlite.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(winner);
    expect(
      (await f.call('associate_pull_request', args, { ...f.token, taskId: loser })).error
    ).toBeDefined();
    expect(
      (
        await f.call(
          'associate_pull_request',
          { ...args, previousTaskId: winner },
          { ...f.token, taskId: loser }
        )
      ).error
    ).toBeUndefined();
    expect(await f.owners(pr(15))).toEqual([loser]);
    expect(
      data(
        await f.call(
          'list_pull_request_associations',
          { prUrl: pr(15) },
          { ...f.token, taskId: loser }
        )
      ).associations
    ).toHaveLength(2);
    f.sqlite.close();
  });

  it('rejects inactive/forged/cross-project callers, foreign repos and stale membership', async () => {
    const f = fixture();
    for (const identity of [
      { ...f.token, taskId: 'old' },
      { ...f.token, userId: 'other' },
      { ...f.token, projectId: 'other' },
      { ...f.token, taskId: null },
    ]) {
      expect(
        (
          await f.call(
            'associate_pull_request',
            { prUrl: pr(14), disposition: 'owned', reason: 'Assigned' },
            identity as McpTokenData
          )
        ).error
      ).toBeDefined();
    }
    for (const url of [
      pr(14) + '/files',
      pr(14) + '?x=1',
      'https://github.com/other/repo/pull/14',
      pr(14) + '0x',
    ]) {
      expect(
        (
          await f.call('associate_pull_request', {
            prUrl: url,
            disposition: 'owned',
            reason: 'Assigned',
          })
        ).error
      ).toBeDefined();
    }
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(14),
          disposition: 'owned',
          reason: 'Assigned',
          taskId: 'next',
        })
      ).error
    ).toBeDefined();
    f.sqlite.exec("UPDATE project_members SET role='viewer' WHERE project_id='p'");
    expect(
      (
        await f.call('associate_pull_request', {
          prUrl: pr(14),
          disposition: 'owned',
          reason: 'Assigned',
        })
      ).error
    ).toBeDefined();
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM task_pull_request_associations').get()
    ).toEqual({ n: 0 });
    f.sqlite.close();
  });
});
