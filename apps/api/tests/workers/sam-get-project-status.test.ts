/**
 * /sam `get_project_status` reports the real ProjectOrchestrator status.
 *
 * The tool used to call `fetch('https://orch/status')` on the orchestrator stub, but
 * ProjectOrchestrator has no fetch handler (it exposes the `getStatus` RPC), so the call threw,
 * the error was swallowed, and the tool always answered `orchestrator: null`. These tests run the
 * tool against the real Durable Object with a mission registered through the real service.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { getProjectStatus } from '../../src/durable-objects/sam-session/tools/get-project-status';
import { startOrchestration } from '../../src/services/project-orchestrator';
import { seedInstallation, seedMission, seedProject, seedUser } from './helpers/seed-d1';

const TEST_PREFIX = `sam-project-status-${Date.now()}`;

async function seedProjectWithMission(suffix: string) {
  const userId = `${TEST_PREFIX}-${suffix}-user`;
  const installationId = `${TEST_PREFIX}-${suffix}-installation`;
  const projectId = `${TEST_PREFIX}-${suffix}-project`;
  const missionId = `${TEST_PREFIX}-${suffix}-mission`;
  await seedUser(userId, { githubId: `${TEST_PREFIX}-${suffix}-gh` });
  await seedInstallation(installationId, userId, {
    installationIdValue: `${TEST_PREFIX}-${suffix}-external-installation`,
  });
  await seedProject(projectId, userId, installationId);
  await seedMission(missionId, projectId, userId);
  await startOrchestration(env, projectId, missionId);
  return { userId, projectId, missionId };
}

interface ProjectStatusResult {
  project?: { id: string };
  orchestrator?: {
    projectId: string;
    activeMissions: Array<{ missionId: string; status: string }>;
  } | null;
  error?: string;
}

describe('/sam get_project_status', () => {
  it('returns the orchestrator status of a project with an active mission', async () => {
    const { userId, projectId, missionId } = await seedProjectWithMission('active');

    const result = (await getProjectStatus(
      { projectId },
      { env: env as unknown as Record<string, unknown>, userId }
    )) as ProjectStatusResult;

    expect(result.project?.id).toBe(projectId);
    expect(result.orchestrator).toMatchObject({
      projectId,
      activeMissions: [{ missionId, status: 'active' }],
    });
  });

  it('still answers, with a null orchestrator, when the orchestrator is unavailable', async () => {
    const { userId, projectId } = await seedProjectWithMission('unavailable');
    // Rejects on a later tick, as a failed RPC does; an already-rejected promise is reported as
    // unhandled by the workers pool before the caller's await attaches its handler.
    const failingOrchestrator = {
      idFromName: (name: string) => env.PROJECT_ORCHESTRATOR.idFromName(name),
      get: () => ({
        getStatus: () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('orchestrator unavailable')), 0);
          }),
      }),
    };

    const result = (await getProjectStatus(
      { projectId },
      {
        env: {
          ...(env as unknown as Record<string, unknown>),
          PROJECT_ORCHESTRATOR: failingOrchestrator,
        },
        userId,
      }
    )) as ProjectStatusResult;

    expect(result.project?.id).toBe(projectId);
    expect(result.orchestrator).toBeNull();
  });

  it('does not report on a project the caller does not own', async () => {
    const { projectId } = await seedProjectWithMission('foreign');
    const otherUserId = `${TEST_PREFIX}-foreign-other-user`;
    await seedUser(otherUserId, { githubId: `${TEST_PREFIX}-foreign-other-gh` });

    const result = (await getProjectStatus(
      { projectId },
      { env: env as unknown as Record<string, unknown>, userId: otherUserId }
    )) as ProjectStatusResult;

    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });
});
