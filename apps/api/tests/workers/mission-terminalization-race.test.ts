/** Completion must test live tasks in the same D1 write that ends the mission. */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectOrchestrator } from '../../src/durable-objects/project-orchestrator';
import type { Env } from '../../src/env';
import { startOrchestration } from '../../src/services/project-orchestrator';
import { seedInstallation, seedMission, seedProject, seedTask, seedUser } from './helpers/seed-d1';

describe('mission terminalization task boundary', () => {
  it.each(['all-terminal', 'zero-task-grace'] as const)(
    'retains active tracking when a queued task arrives during %s completion',
    async (reason) => {
      const project = `terminal-${reason}-project`,
        owner = `terminal-${reason}-owner`,
        mission = `terminal-${reason}-mission`;
      await seedUser(owner);
      await seedInstallation(`terminal-${reason}-install`, owner);
      await seedProject(project, owner, `terminal-${reason}-install`);
      await seedMission(mission, project, owner);
      if (reason === 'all-terminal') {
        await seedTask(`${mission}-done`, project, owner, { status: 'completed' });
        await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE id=?')
          .bind(mission, `${mission}-done`)
          .run();
      }
      await startOrchestration(env, project, mission);
      const stub = env.PROJECT_ORCHESTRATOR.get(
        env.PROJECT_ORCHESTRATOR.idFromName(project)
      ) as DurableObjectStub<ProjectOrchestrator>;
      await runInDurableObject(stub, async (instance, state) => {
        if (reason === 'zero-task-grace')
          state.storage.sql.exec(
            'UPDATE orchestrator_missions SET registered_at=? WHERE mission_id=?',
            Date.now() - 11 * 60_000,
            mission
          );
        const target = instance as unknown as { env: Env };
        const original = target.env;
        let inserted = false;
        target.env = {
          ...original,
          DATABASE: {
            ...original.DATABASE,
            batch: original.DATABASE.batch.bind(original.DATABASE),
            prepare(query: string) {
              const statement = original.DATABASE.prepare(query);
              if (!query.includes('UPDATE missions SET status =')) return statement;
              return {
                bind(...values: unknown[]) {
                  const bound = statement.bind(...values);
                  return {
                    run: async () => {
                      if (!inserted) {
                        inserted = true;
                        await seedTask(`${mission}-late`, project, owner, { status: 'queued' });
                        await original.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE id=?')
                          .bind(mission, `${mission}-late`)
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
          await instance.alarm();
          expect(inserted).toBe(true);
          expect(
            await original.DATABASE.prepare('SELECT status FROM missions WHERE id=?')
              .bind(mission)
              .first()
          ).toEqual({ status: 'planning' });
          expect(
            state.storage.sql
              .exec('SELECT status FROM orchestrator_missions WHERE mission_id=?', mission)
              .one().status
          ).toBe('active');
          expect(await state.storage.getAlarm()).not.toBeNull();
        } finally {
          target.env = original;
          await state.storage.deleteAlarm();
        }
      });
    }
  );

  it('preserves the intentional maximum-lifetime exit with unfinished tasks', async () => {
    const project = 'terminal-limit-project',
      owner = 'terminal-limit-owner',
      mission = 'terminal-limit-mission';
    await seedUser(owner);
    await seedInstallation('terminal-limit-install', owner);
    await seedProject(project, owner, 'terminal-limit-install');
    await seedMission(mission, project, owner);
    await seedTask('terminal-limit-queued', project, owner, { status: 'queued' });
    await env.DATABASE.prepare('UPDATE tasks SET mission_id=? WHERE id=?')
      .bind(mission, 'terminal-limit-queued')
      .run();
    await startOrchestration(env, project, mission);
    const stub = env.PROJECT_ORCHESTRATOR.get(
      env.PROJECT_ORCHESTRATOR.idFromName(project)
    ) as DurableObjectStub<ProjectOrchestrator>;
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        'UPDATE orchestrator_missions SET registered_at=? WHERE mission_id=?',
        Date.now() - 25 * 60 * 60_000,
        mission
      );
      await state.storage.deleteAlarm();
      await instance.alarm();
      expect(state.storage.sql.exec('SELECT 1 FROM orchestrator_missions').toArray()).toHaveLength(
        0
      );
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(
      await env.DATABASE.prepare('SELECT status FROM missions WHERE id=?').bind(mission).first()
    ).toEqual({ status: 'completed' });
    expect(
      await env.DATABASE.prepare(
        "SELECT status FROM tasks WHERE id='terminal-limit-queued'"
      ).first()
    ).toEqual({ status: 'queued' });
  });
});
