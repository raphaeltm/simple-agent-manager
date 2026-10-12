import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { callMcpTool, createMcpApp, storeMcpToken, toolResult } from '../helpers/mcp-route';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

it('finds canonical long PR URLs through the real MCP route and D1', async () => {
  const user = 'long-pr-owner-user';
  const project = 'long-pr-owner-project';
  const other = 'long-pr-owner-other-project';
  const installation = 'long-pr-owner-installation';
  const token = 'long-pr-owner-token';
  const url = 'https://github.com/raphaeltm/simple-agent-manager/pull/2302';
  expect(new TextEncoder().encode(`%${url}%`).length).toBeGreaterThan(50);
  await seedUser(user);
  await seedInstallation(installation, user);
  await seedProject(project, user, installation);
  await seedProject(other, user, installation);
  for (const [id, projectId, status, outputUrl, description] of [
    ['long-url-exact', project, 'sleeping', url, 'No description link'],
    ['long-url-description', project, 'queued', null, `Complete ${url}: verify gates`],
    ['long-url-other-project', other, 'queued', url, url],
    ['long-url-terminal', project, 'completed', url, url],
    ['long-url-caller', project, 'in_progress', url, url],
    ['long-url-unrelated', project, 'queued', null, `${url.replace('2302', '9999')}`],
  ]) {
    await env.DATABASE.prepare(
      `INSERT INTO tasks (id, project_id, user_id, title, status, output_pr_url, description, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(id, projectId, user, id, status, outputUrl, description, user)
      .run();
  }
  await storeMcpToken(env.KV, token, {
    taskId: 'long-url-caller',
    projectId: project,
    userId: user,
    workspaceId: 'long-url-workspace',
  });
  const result = toolResult<{ agents: Array<{ taskId: string }>; filter: { prUrl: string } }>(
    await callMcpTool(await createMcpApp(), env as unknown as Env, token, 'list_project_agents', {
      prUrl: url,
    })
  );
  expect(result.filter).toEqual({ prUrl: url });
  expect(result.agents.map((agent) => agent.taskId).sort()).toEqual([
    'long-url-description',
    'long-url-exact',
  ]);
});
