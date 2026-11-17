/** Real ProjectOrchestrator -> ProjectData RPC + D1 cancellation contract. */
import type { ProjectData } from '@simple-agent-manager/project-data/internal/do/index';
import { acceptPromptDelivery } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import type { Env } from '../../src/env';
import { cancelMission, startOrchestration } from '../../src/services/project-orchestrator';
import {
  seedInstallation,
  seedMission,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

describe('mission cancellation wake retirement', () => {
  it('retires old prompts and its wake claim while preserving completed tasks and fresh follow-ups', async () => {
    const project = 'mission-cancel-wake-project';
    const owner = 'mission-cancel-wake-owner';
    const task = 'mission-cancel-wake-task';
    const mission = 'mission-cancel-wake';
    await seedUser(owner);
    await seedInstallation('mission-cancel-install', owner);
    await seedProject(project, owner, 'mission-cancel-install');
    await seedMission(mission, project, owner);
    const data = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(project)
    ) as DurableObjectStub<ProjectData>;
    await data.ensureProjectId(project);
    const session = await data.createSession(null, 'Cancel pending wake', task, owner);
    await seedWorkspace('mission-cancel-ws', null, owner, {
      projectId: project,
      status: 'deleted',
    });
    await seedTask(task, project, owner, { status: 'queued', chatSessionId: session });
    await seedTask('mission-already-complete', project, owner, { status: 'completed' });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE project_id=?')
      .bind(mission, project)
      .run();
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots
      (id,workspace_id,project_id,user_id,chat_session_id,runtime,status,degradation,
       manifest_r2_key,manifest_json,expires_at,sleeping_at,sleep_status,
       recovery_status,recovery_task_id,recovery_attempt_id,recovery_attempts)
      VALUES('mission-cancel-snapshot','mission-cancel-ws',?,?,?,'vm','available','none',
       'saved/manifest','{}','2099-01-01T00:00:00Z','2026-11-17T00:00:00Z','sleeping',
       'waking',?,'old-mission-wake',1)`
    )
      .bind(project, owner, session, task)
      .run();
    const accept = (deliveryId: string) =>
      runInDurableObject(data, (_instance, state) =>
        acceptPromptDelivery(
          state.storage.sql,
          {},
          {
            deliveryId,
            targetSessionId: session,
            displayContent: deliveryId,
            senderType: 'human',
            senderId: owner,
            sourceKind: 'user_followup',
            ttlMs: 60_000,
          },
          Date.now()
        )
      );
    await accept('mission-old-followup');
    await startOrchestration(env, project, mission);
    expect(await cancelMission(env, project, mission)).toBe(true);
    expect(
      await env.DATABASE.prepare(
        'SELECT recovery_attempt_id,recovery_status,status FROM session_snapshots WHERE project_id=?'
      )
        .bind(project)
        .first()
    ).toEqual({ recovery_attempt_id: null, recovery_status: 'failed', status: 'available' });
    expect(
      await env.DATABASE.prepare(
        "SELECT status FROM tasks WHERE id='mission-already-complete'"
      ).first()
    ).toEqual({ status: 'completed' });
    await runInDurableObject(data, (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT delivery_state,terminal_reason FROM session_inbox WHERE id='mission-old-followup'"
          )
          .one()
      ).toMatchObject({ delivery_state: 'failed', terminal_reason: 'task_cancelled' });
    });
    await accept('mission-fresh-followup');
    await runInDurableObject(data, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT delivery_state FROM session_inbox WHERE id='mission-fresh-followup'")
          .one()
      ).toMatchObject({ delivery_state: 'queued' });
    });
  });
  it('drains more than one page through the actual alarm and stops rearming when complete', async () => {
    const project = 'mission-page-project',
      owner = 'mission-page-owner',
      mission = 'mission-page';
    await seedUser(owner);
    await seedInstallation('mission-page-install', owner);
    await seedProject(project, owner, 'mission-page-install');
    await seedMission(mission, project, owner);
    for (let i = 0; i < 26; i++) {
      const id = `mission-page-${String(i).padStart(3, '0')}`;
      await seedTask(id, project, owner, { status: 'queued' });
      await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE id=?')
        .bind(mission, id)
        .run();
    }
    await startOrchestration(env, project, mission);
    await cancelMission(env, project, mission);
    expect(
      await env.DATABASE.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE mission_id=? AND status='cancelled'"
      )
        .bind(mission)
        .first()
    ).toEqual({ n: 25 });
    expect(
      await env.DATABASE.prepare('SELECT status FROM missions WHERE id=?').bind(mission).first()
    ).toEqual({ status: 'paused' });
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()).toHaveLength(
        0
      );
      expect(await state.storage.getAlarm()).toBeNull();
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(
      await env.DATABASE.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE mission_id=? AND status='cancelled'"
      )
        .bind(mission)
        .first()
    ).toEqual({ n: 26 });
    expect(
      await env.DATABASE.prepare('SELECT status FROM missions WHERE id=?').bind(mission).first()
    ).toEqual({ status: 'cancelled' });
  });

  it('advances past a failing head, blocks after finite passes, and permits explicit retry', async () => {
    const project = 'mission-retry-project',
      owner = 'mission-retry-owner',
      mission = 'mission-retry';
    await seedUser(owner);
    await seedInstallation('mission-retry-install', owner);
    await seedProject(project, owner, 'mission-retry-install');
    await seedMission(mission, project, owner);
    const data = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(project)
    ) as DurableObjectStub<ProjectData>;
    await data.ensureProjectId(project);
    const session = await data.createSession(null, 'Failed retirement', 'a-mission-bad', owner);
    await seedTask('a-mission-bad', project, owner, { status: 'queued', chatSessionId: session });
    await seedTask('z-mission-good', project, owner, { status: 'queued' });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE project_id=?')
      .bind(mission, project)
      .run();
    await startOrchestration(env, project, mission);
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as { env: Env };
      const original = target.env;
      target.env = {
        ...original,
        ORCHESTRATOR_CANCELLATION_PAGE_SIZE: '1',
        ORCHESTRATOR_CANCELLATION_RETRY_PASSES: '2',
        PROJECT_DATA: {
          idFromName: original.PROJECT_DATA.idFromName.bind(original.PROJECT_DATA),
          get() {
            throw new Error('retirement unavailable');
          },
        } as unknown as Env['PROJECT_DATA'],
      };
      try {
        expect(await instance.cancelMission(project, mission)).toBe(true);
        for (let i = 0; i < 5; i++) {
          await state.storage.deleteAlarm();
          await instance.alarm();
        }
        expect(
          state.storage.sql
            .exec('SELECT status FROM orchestrator_missions WHERE mission_id=?', mission)
            .one().status
        ).toBe('cancel_blocked');
        expect(await state.storage.getAlarm()).toBeNull();
        expect(
          await original.DATABASE.prepare(
            "SELECT status FROM tasks WHERE id='z-mission-good'"
          ).first()
        ).toEqual({ status: 'cancelled' });
        expect(
          await original.DATABASE.prepare(
            "SELECT status FROM tasks WHERE id='a-mission-bad'"
          ).first()
        ).toEqual({ status: 'queued' });
      } finally {
        target.env = original;
      }
      expect(await instance.cancelMission(project, mission)).toBe(true);
      expect(state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()).toHaveLength(
        0
      );
    });
    expect(
      await env.DATABASE.prepare('SELECT status FROM missions WHERE id=?').bind(mission).first()
    ).toEqual({ status: 'cancelled' });
  });
  it('bounds an unresponsive retirement and stops expired cancellation episodes', async () => {
    const project = 'mission-timeout-project',
      owner = 'mission-timeout-owner',
      mission = 'mission-timeout';
    await seedUser(owner);
    await seedInstallation('mission-timeout-install', owner);
    await seedProject(project, owner, 'mission-timeout-install');
    await seedMission(mission, project, owner);
    await seedTask('mission-timeout-task', project, owner, {
      status: 'queued',
      chatSessionId: 'mission-timeout-session',
    });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE project_id=?')
      .bind(mission, project)
      .run();
    await startOrchestration(env, project, mission);
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as { env: Env };
      const original = target.env;
      target.env = {
        ...original,
        ORCHESTRATOR_CANCELLATION_TURN_MS: '10',
        ORCHESTRATOR_CANCELLATION_RESIDENCE_MS: '1000',
        PROJECT_DATA: {
          idFromName: original.PROJECT_DATA.idFromName.bind(original.PROJECT_DATA),
          get() {
            return {
              ensureProjectId: async () => {},
              cancelUnissuedSessionPrompts: () => new Promise(() => {}),
            };
          },
        } as unknown as Env['PROJECT_DATA'],
      };
      try {
        const start = Date.now();
        expect(await instance.cancelMission(project, mission)).toBe(true);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(
          await original.DATABASE.prepare(
            "SELECT status FROM tasks WHERE id='mission-timeout-task'"
          ).first()
        ).toEqual({ status: 'queued' });
        expect(
          state.storage.sql.exec('SELECT status FROM orchestrator_missions').one().status
        ).toBe('cancelling');
        state.storage.sql.exec(
          'UPDATE orchestrator_missions SET cancellation_started_at=? WHERE mission_id=?',
          Date.now() - 1001,
          mission
        );
        (instance as unknown as { projectId: string | null }).projectId = null;
        expect(await state.storage.get('projectId')).toBe(project);
        target.env = {
          ...target.env,
          DATABASE: {
            prepare() {
              throw new Error('D1 unavailable');
            },
          } as unknown as Env['DATABASE'],
        };
        await state.storage.deleteAlarm();
        await instance.alarm();
        expect(
          state.storage.sql.exec('SELECT status FROM orchestrator_missions').one().status
        ).toBe('cancel_blocked');
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        target.env = original;
      }
    });
  });
  it('keeps tracking when a late task wins the atomic completion boundary', async () => {
    const project = 'mission-final-cas-project',
      owner = 'mission-final-cas-owner',
      mission = 'mission-final-cas';
    await seedUser(owner);
    await seedInstallation('mission-final-cas-install', owner);
    await seedProject(project, owner, 'mission-final-cas-install');
    await seedMission(mission, project, owner);
    await startOrchestration(env, project, mission);
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as { env: Env };
      const original = target.env;
      let inserted = false;
      target.env = {
        ...original,
        DATABASE: {
          ...original.DATABASE,
          prepare(query: string) {
            const statement = original.DATABASE.prepare(query);
            if (!query.includes("UPDATE missions SET status='cancelled'")) return statement;
            return {
              bind(...values: unknown[]) {
                const bound = statement.bind(...values);
                return {
                  run: async () => {
                    if (!inserted) {
                      inserted = true;
                      await seedTask('mission-final-late-task', project, owner, {
                        status: 'queued',
                      });
                      await original.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE id=?')
                        .bind(mission, 'mission-final-late-task')
                        .run();
                    }
                    return bound.run();
                  },
                };
              },
            };
          },
        } as unknown as Env['DATABASE'],
      };
      try {
        expect(await instance.cancelMission(project, mission)).toBe(true);
        expect(inserted).toBe(true);
        expect(
          state.storage.sql.exec('SELECT status FROM orchestrator_missions').one().status
        ).toBe('cancelling');
        expect(
          await original.DATABASE.prepare('SELECT status FROM missions WHERE id=?')
            .bind(mission)
            .first()
        ).toEqual({ status: 'paused' });
      } finally {
        target.env = original;
      }
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()).toHaveLength(
        0
      );
    });
    expect(
      await env.DATABASE.prepare(
        "SELECT status FROM tasks WHERE id='mission-final-late-task'"
      ).first()
    ).toEqual({ status: 'cancelled' });
  });
  it('preserves a cancellation marker installed while an older cycle terminalizes', async () => {
    const project = 'mission-cycle-race-project',
      owner = 'mission-cycle-race-owner',
      mission = 'mission-cycle-race';
    await seedUser(owner);
    await seedInstallation('mission-cycle-race-install', owner);
    await seedProject(project, owner, 'mission-cycle-race-install');
    await seedMission(mission, project, owner);
    await seedTask('mission-cycle-done', project, owner, { status: 'completed' });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE project_id=?')
      .bind(mission, project)
      .run();
    await startOrchestration(env, project, mission);
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as { env: Env };
      const original = target.env;
      let enter: () => void = () => {},
        release: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      target.env = {
        ...original,
        DATABASE: {
          ...original.DATABASE,
          batch: original.DATABASE.batch.bind(original.DATABASE),
          prepare(query: string) {
            const statement = original.DATABASE.prepare(query);
            if (!query.includes('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?'))
              return statement;
            return {
              bind(...values: unknown[]) {
                const bound = statement.bind(...values);
                return {
                  run: async () => {
                    enter();
                    await barrier;
                    return bound.run();
                  },
                };
              },
            };
          },
        } as unknown as Env['DATABASE'],
      };
      try {
        const cycle = instance.alarm();
        await entered;
        const cancellation = instance.cancelMission(project, mission);
        for (let i = 0; i < 20; i++) {
          if (
            state.storage.sql.exec('SELECT status FROM orchestrator_missions').one().status ===
            'cancelling'
          )
            break;
          await original.DATABASE.prepare('SELECT 1').first();
        }
        expect(
          state.storage.sql.exec('SELECT status FROM orchestrator_missions').one().status
        ).toBe('cancelling');
        release();
        await cycle;
        expect(await cancellation).toBe(true);
        expect(
          await original.DATABASE.prepare('SELECT status FROM missions WHERE id=?')
            .bind(mission)
            .first()
        ).toEqual({ status: 'cancelled' });
        expect(
          state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()
        ).toHaveLength(0);
      } finally {
        release();
        target.env = original;
      }
    });
  });
  it.each(['pauseMission', 'resumeMission'] as const)(
    'fences an old %s write against real cancellation',
    async (method) => {
      const project = `mission-control-${method}-project`,
        owner = `mission-control-${method}-owner`,
        mission = `mission-control-${method}`;
      await seedUser(owner);
      await seedInstallation(`mission-control-${method}-install`, owner);
      await seedProject(project, owner, `mission-control-${method}-install`);
      await seedMission(mission, project, owner);
      await seedTask(`${mission}-task`, project, owner, { status: 'queued' });
      await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE project_id=?')
        .bind(mission, project)
        .run();
      await startOrchestration(env, project, mission);
      const stub = env.PROJECT_ORCHESTRATOR.get(
        env.PROJECT_ORCHESTRATOR.idFromName(project)
      ) as DurableObjectStub<ProjectOrchestrator>;
      await runInDurableObject(stub, async (instance, state) => {
        if (method === 'resumeMission')
          expect(await instance.pauseMission(project, mission)).toBe(true);
        const target = instance as unknown as { env: Env };
        const original = target.env;
        let enter: () => void = () => {},
          release: () => void = () => {};
        const entered = new Promise<void>((resolve) => {
          enter = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        target.env = {
          ...original,
          DATABASE: {
            ...original.DATABASE,
            batch: original.DATABASE.batch.bind(original.DATABASE),
            prepare(query: string) {
              const statement = original.DATABASE.prepare(query);
              if (!/UPDATE missions SET status\s*=\s*\?/.test(query)) return statement;
              return {
                bind(...values: unknown[]) {
                  const bound = statement.bind(...values);
                  return {
                    run: async () => {
                      enter();
                      await barrier;
                      return bound.run();
                    },
                  };
                },
              };
            },
          } as unknown as Env['DATABASE'],
        };
        try {
          const oldControl = instance[method](project, mission);
          await entered;
          const cancellation = instance.cancelMission(project, mission);
          // Either waiting for the old write or rejecting it with CAS is safe.
          // Let an unfenced cancellation finish before releasing its stale writer.
          await Promise.race([cancellation, new Promise((resolve) => setTimeout(resolve, 100))]);
          release();
          await oldControl;
          expect(await cancellation).toBe(true);
          expect(
            await original.DATABASE.prepare('SELECT status FROM missions WHERE id=?')
              .bind(mission)
              .first()
          ).toEqual({ status: 'cancelled' });
          expect(
            await original.DATABASE.prepare('SELECT status FROM tasks WHERE id=?')
              .bind(`${mission}-task`)
              .first()
          ).toEqual({ status: 'cancelled' });
          expect(
            state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()
          ).toHaveLength(0);
          expect(await instance[method](project, mission)).toBe(false);
        } finally {
          release();
          target.env = original;
        }
      });
    }
  );
});
