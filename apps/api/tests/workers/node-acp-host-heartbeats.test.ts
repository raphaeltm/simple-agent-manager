import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { getLocalTaskRuntimeLiveness } from '../../src/durable-objects/project-data/task-runtime-liveness';
import type { Env as ProjectDataEnv } from '../../src/durable-objects/project-data/types';
import type { Env } from '../../src/env';
import { nodeAcpHeartbeatRoute } from '../../src/routes/projects/node-acp-heartbeat';
import { getTaskRuntimeLiveness } from '../../src/scheduled/stuck-tasks';
import { signNodeCallbackToken } from '../../src/services/jwt';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

afterEach(() => vi.unstubAllGlobals());

describe('node heartbeat is distinct from the task agent host', () => {
  it.each([
    { hostStatus: 'stopped', sleep: null }, { hostStatus: 'ready', sleep: null },
    { hostStatus: 'prompting', sleep: null }, { hostStatus: 'unknown', sleep: null },
    { hostStatus: 'unreachable', sleep: null }, { hostStatus: null, sleep: null },
    { hostStatus: undefined, sleep: null }, { hostStatus: 'stopped', sleep: 'stopping' },
    { hostStatus: 'ready', sleep: 'sleeping' },
    { hostStatus: 'stopped', sleep: null, secondHostStatus: 'ready' },
    { hostStatus: 'stopped', sleep: null, secondHostStatus: 'unknown' },
  ])(
    'host $hostStatus with sleep $sleep through the real heartbeat route',
    async ({ hostStatus, sleep, secondHostStatus }) => {
      const id = crypto.randomUUID();
      const userId = `u-${id}`,
        projectId = `p-${id}`,
        nodeId = `n-${id}`,
        workspaceId = `w-${id}`;
      await seedUser(userId);
      await seedInstallation(`i-${id}`, userId);
      await seedProject(projectId, userId, `i-${id}`);
      await seedNode(nodeId, userId, {
        status: 'running',
        healthStatus: 'healthy',
        lastHeartbeatAt: new Date().toISOString(),
      });
      const stub = env.PROJECT_DATA.get(
        env.PROJECT_DATA.idFromName(projectId)
      ) as DurableObjectStub<ProjectData>;
      await stub.ensureProjectId(projectId);
      const chatId = await stub.createSession(null, 'Host liveness');
      await seedWorkspace(workspaceId, nodeId, userId, {
        projectId,
        status: 'running',
        chatSessionId: chatId,
      });
      const acp = await stub.createAcpSession({
        chatSessionId: chatId,
        initialPrompt: null,
        agentType: 'openai-codex',
      });
      await stub.transitionAcpSession(acp.id, 'assigned', {
        actorType: 'system',
        nodeId,
        workspaceId,
      });
      await stub.transitionAcpSession(acp.id, 'running', {
        actorType: 'vm-agent',
        actorId: nodeId,
      });
      const stale = hostStatus === 'stopped' ? Date.now() : Date.now() - 600_000;
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec(
          'UPDATE acp_sessions SET last_heartbeat_at = ? WHERE id = ?',
          stale,
          acp.id
        );
      });
      let secondId: string | null = null;
      const hosts = [{ id: acp.id, workspaceId, status: 'running', hostStatus }];
      if (secondHostStatus) {
        const second = await stub.createAcpSession({
          chatSessionId: chatId, initialPrompt: null, agentType: 'openai-codex',
        });
        secondId = second.id;
        await stub.transitionAcpSession(second.id, 'assigned', { actorType: 'system', nodeId, workspaceId });
        await stub.transitionAcpSession(second.id, 'running', { actorType: 'vm-agent', actorId: nodeId });
        await runInDurableObject(stub, async (_instance, state) => {
          state.storage.sql.exec('UPDATE acp_sessions SET created_at = ? WHERE id = ?', acp.createdAt - 1000, second.id);
        });
        hosts.push({ id: second.id, workspaceId, status: 'running', hostStatus: secondHostStatus });
      }
      const fetchSpy = vi.fn(async () =>
        Response.json({ sessions: hosts })
      );
      vi.stubGlobal('fetch', fetchSpy);
      const token = await signNodeCallbackToken(nodeId, env as unknown as Env);
      const response = await nodeAcpHeartbeatRoute.request(
        `/${projectId}/node-acp-heartbeat`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId }),
        },
        env as unknown as Env
      );
      expect(response.status).toBe(204);
      // The real node producer refreshed ACP although the host may be stopped.
      // The suspect-task adapters must disagree with that proxy.
      expect(fetchSpy).not.toHaveBeenCalled();
      const session = await stub.getAcpSession(acp.id);
      expect(session?.lastHeartbeatAt).toBeGreaterThanOrEqual(stale);
      expect(session?.status).toBe('running');
      if (hostStatus === 'unreachable') fetchSpy.mockImplementation(async () => { throw new Error('network failure'); });
      await seedTask(`t-${id}`, projectId, userId, { status: 'in_progress', workspaceId, chatSessionId: chatId });
      if (sleep) {
        const now = new Date().toISOString();
        await env.DATABASE.prepare(`INSERT INTO session_snapshots
          (id, project_id, workspace_id, node_id, user_id, chat_session_id, agent_session_id, runtime, status, degradation,
           manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_claimed_at, sleep_stopping_since, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'vm', 'available', 'none', 'snapshot/manifest.json', ?, ?, ?, ?, ?, ?, ?)`)
          .bind(`s-${id}`, projectId, workspaceId, nodeId, userId, chatId, acp.id, new Date(Date.now() + 86400000).toISOString(),
            sleep === 'sleeping' ? now : null, sleep, now, now, now, now).run();
        if (sleep === 'sleeping') await env.DATABASE.prepare("UPDATE workspaces SET status = 'sleeping' WHERE id = ?").bind(workspaceId).run();
      }
      const verdict = await getTaskRuntimeLiveness(env as unknown as Env,
        { id: `t-${id}`, project_id: projectId, workspace_id: workspaceId, chat_session_id: chatId });
      expect(fetchSpy).toHaveBeenCalledTimes(sleep === 'sleeping' ? 0 : 1);
      const liveHost = !sleep && (hostStatus === 'ready' || hostStatus === 'prompting' || secondHostStatus === 'ready');
      expect(verdict.live).toBe(liveHost);
      expect(verdict.conclusive).toBe(!sleep && hostStatus !== 'unknown' && hostStatus !== 'unreachable' && secondHostStatus !== 'unknown');
      if (liveHost) expect(verdict.reason).toBe('task_agent_host_running');
      if (hostStatus === 'unknown' || hostStatus === 'unreachable' || secondHostStatus === 'unknown') expect(verdict.reason).toBe('task_agent_host_unknown');
      const local = await runInDurableObject(stub, async (_instance, state) => getLocalTaskRuntimeLiveness(
        state.storage.sql, env as unknown as ProjectDataEnv,
        { taskId: `t-${id}`, projectId, workspaceId, chatSessionId: chatId, acpSessionId: secondHostStatus ? undefined : acp.id }));
      if (secondHostStatus === 'ready') expect(verdict.activeAcpSessionId).toBe(secondId);
      expect(local.live).toBe(verdict.live);
      expect(local.conclusive).toBe(verdict.conclusive);
      if (secondHostStatus === 'ready') expect(local.activeAcpSessionId).toBe(secondId);
      if (secondHostStatus === 'ready') {
        const exactStopped = await runInDurableObject(stub, async (_instance, state) =>
          getLocalTaskRuntimeLiveness(state.storage.sql, env as unknown as ProjectDataEnv, {
            taskId: 't-' + id, projectId, workspaceId, chatSessionId: chatId, acpSessionId: acp.id,
          })
        );
        expect(exactStopped.live).toBe(false);
        expect(exactStopped.conclusive).toBe(true);
      }
      // An unreachable inspection never changes the ACP lifecycle by itself.
      expect((await stub.getAcpSession(acp.id))?.status).toBe('running');
    }
  );
});
