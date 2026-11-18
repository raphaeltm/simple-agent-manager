/** Real alarm -> placement -> D1 admission CAS -> real held TaskRunner start. */
import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../src/db/schema';
import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import type { StartTaskInput, TaskRunner } from '../../src/durable-objects/task-runner';
import type { Env } from '../../src/env';
import { startOrchestration } from '../../src/services/project-orchestrator';
import { ensurePoolsWithStarterMachines } from '../helpers/capacity-pool-picks';
import { seedInstallation, seedMission, seedProject, seedTask, seedUser } from './helpers/seed-d1';

describe('mission scheduler initial planning status', () => {
  it.each(['planning', 'active', 'paused'] as const)(
    'processes the real %s mission without bypassing the dispatch fence',
    async (status) => {
      const project = `auto-${status}-project`,
        owner = `auto-${status}-owner`,
        mission = `auto-${status}-mission`,
        task = `auto-${status}-task`;
      await seedUser(owner);
      await seedInstallation(`auto-${status}-install`, owner);
      await seedProject(project, owner, `auto-${status}-install`);
      await env.DATABASE.prepare(
        "UPDATE projects SET default_provider='hetzner',default_location='nbg1',default_vm_size='small',default_agent_type='opencode' WHERE id=?"
      )
        .bind(project)
        .run();
      const now = new Date().toISOString();
      await env.DATABASE.prepare(
        `INSERT INTO credentials
      (id,user_id,project_id,provider,credential_type,credential_kind,is_active,encrypted_token,iv,created_at,updated_at)
      VALUES(?,?,?,'hetzner','cloud-provider','api-key',1,'fixture-token','fixture-iv',?,?)`
      )
        .bind(`auto-${status}-credential`, owner, project, now, now)
        .run();
      await ensurePoolsWithStarterMachines(drizzle(env.DATABASE, { schema }) as never, {
        userId: owner,
        projectId: project,
        includeInstallation: false,
        owner: { userId: owner, projectId: project },
      });
      await seedMission(mission, project, owner, { status });
      await seedTask(task, project, owner, { status: 'queued' });
      await env.DATABASE.prepare(
        "UPDATE tasks SET mission_id=?,scheduler_state='schedulable' WHERE id=?"
      )
        .bind(mission, task)
        .run();
      await startOrchestration(env, project, mission);
      const stub = env.PROJECT_ORCHESTRATOR.get(
        env.PROJECT_ORCHESTRATOR.idFromName(project)
      ) as DurableObjectStub<ProjectOrchestrator>;
      const runner = env.TASK_RUNNER.get(
        env.TASK_RUNNER.idFromName(task)
      ) as DurableObjectStub<TaskRunner>;
      let starts = 0;
      await runInDurableObject(stub, async (instance, state) => {
        const target = instance as unknown as { env: Env };
        const original = target.env;
        target.env = {
          ...original,
          TASK_RUNNER: {
            idFromName: original.TASK_RUNNER.idFromName.bind(original.TASK_RUNNER),
            get(id: DurableObjectId) {
              return {
                start: async (input: StartTaskInput) => {
                  starts++;
                  await runInDurableObject(
                    original.TASK_RUNNER.get(id) as DurableObjectStub<TaskRunner>,
                    async (actual, runnerState) => {
                      await actual.start(input);
                      await runnerState.storage.deleteAlarm();
                    }
                  );
                },
              };
            },
          } as unknown as Env['TASK_RUNNER'],
        };
        try {
          await instance.alarm();
        } finally {
          target.env = original;
          await state.storage.deleteAlarm();
        }
      });
      const row = await env.DATABASE.prepare('SELECT status,chat_session_id FROM tasks WHERE id=?')
        .bind(task)
        .first<{ status: string; chat_session_id: string | null }>();
      expect(row?.status).toBe('queued');
      if (status === 'paused') {
        expect(starts).toBe(0);
        expect(row?.chat_session_id).toBeNull();
        expect(await runner.getStatus()).toBeNull();
      } else {
        expect(starts).toBe(1);
        expect(row?.chat_session_id).toEqual(expect.any(String));
        expect(await runner.getStatus()).toMatchObject({
          currentStep: 'node_selection',
          stepResults: { chatSessionId: row?.chat_session_id },
        });
      }
      expect(
        await env.DATABASE.prepare('SELECT status FROM missions WHERE id=?').bind(mission).first()
      ).toEqual({ status });
    }
  );
});
