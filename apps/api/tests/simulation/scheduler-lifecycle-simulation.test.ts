import fc from 'fast-check';

import { SchedulerLifecycleWorld } from './scheduler-lifecycle-harness';
import {
  CAPACITY_TOCTOU_POLICY,
  CURRENT_SCHEDULER_POLICY,
  PREMATURE_CLEANUP_POLICY,
  resolveSimulationProfile,
  type SimulationCommand,
  STRANDED_SLEEP_POLICY,
} from './scheduler-lifecycle-model';

const profile = resolveSimulationProfile();

const taskCommand = fc.record({
  type: fc.constant<'submit'>('submit'),
  task: fc.integer({ min: 0, max: profile.taskSlots - 1 }),
  project: fc.integer({ min: 0, max: profile.projectCount - 1 }),
  node: fc.oneof(fc.integer({ min: 0, max: 1 }), fc.constant<'new'>('new')),
});

const commandArbitrary: fc.Arbitrary<SimulationCommand> = fc.oneof(
  { weight: 5, arbitrary: taskCommand },
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant<'complete'>('complete'),
      task: fc.integer({ min: 0, max: profile.taskSlots - 1 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant<'activity'>('activity'),
      task: fc.integer({ min: 0, max: profile.taskSlots - 1 }),
      activity: fc.constantFrom<'prompting' | 'idle'>('prompting', 'idle'),
    }),
  },
  { weight: 3, arbitrary: fc.constant<SimulationCommand>({ type: 'sleep-sweep' }) },
  { weight: 2, arbitrary: fc.constant<SimulationCommand>({ type: 'cleanup-sweep' }) },
  { weight: 1, arbitrary: fc.constant<SimulationCommand>({ type: 'snapshot-failure' }) },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant<'advance'>('advance'),
      milliseconds: fc.integer({ min: 0, max: 60_000 }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      type: fc.constant<'run-event'>('run-event'),
      choice: fc.nat({ max: profile.taskSlots * 2 }),
    }),
  }
);

function execute(world: SchedulerLifecycleWorld, commands: SimulationCommand[]): void {
  for (const command of commands) {
    world.apply(command);
    world.assertSafety();
  }
}

describe('scheduler lifecycle simulation calibration', () => {
  it('rejects the stranded completed-session retry behavior from the sleep incident', () => {
    const world = new SchedulerLifecycleWorld(STRANDED_SLEEP_POLICY, 1);
    world.submitTask(0, 0, 0);
    world.runNextEvent();
    world.completeTask(0);
    world.setActivity(0, 'idle');
    world.now += 5_000;
    world.runSleepSweep();
    world.recover();

    expect(() => world.assertConverged()).toThrow(/terminal session .* did not converge/);
  });

  it('rejects cleanup that deletes a pre-heartbeat task-owned provisioning node', () => {
    const world = new SchedulerLifecycleWorld(PREMATURE_CLEANUP_POLICY, 1);
    world.submitTask(0, 0, 'new');
    world.now += 31_000;
    world.runCleanupSweep();

    expect(() => world.assertSafety()).toThrow(/active task .* destroying node/);
  });

  it('rejects two placements that both observe the final node slot', () => {
    const world = new SchedulerLifecycleWorld(CAPACITY_TOCTOU_POLICY, 1);
    world.submitTask(0, 0, 0);
    world.submitTask(1, 1, 0);
    world.runNextEvent();
    world.runNextEvent();

    expect(() => world.assertSafety()).toThrow(/capacity exceeded/);
  });

  it('accepts the same incident schedules with durable claims and retry coverage', () => {
    const world = new SchedulerLifecycleWorld(CURRENT_SCHEDULER_POLICY, 1);
    world.submitTask(0, 0, 'new');
    world.runCleanupSweep();
    world.runNextEvent();
    world.runNextEvent();
    world.completeTask(0);
    world.runSleepSweep();
    world.setActivity(0, 'idle');
    world.now += 5_000;
    world.runSleepSweep();
    world.recover();

    world.assertSafety();
    world.assertConverged();
  });
});

describe(`scheduler lifecycle generated exploration (${profile.numRuns} runs)`, () => {
  it(
    'preserves safety under faults and converges after faults stop',
    () => {
      const seed = process.env.FC_SEED ? Number.parseInt(process.env.FC_SEED, 10) : undefined;
      const path = process.env.FC_PATH;

      fc.assert(
        fc.property(
          fc.array(commandArbitrary, { minLength: 10, maxLength: profile.maxCommands }),
          (commands) => {
            const world = new SchedulerLifecycleWorld(CURRENT_SCHEDULER_POLICY);
            execute(world, commands);
            world.recover();
            world.assertSafety();
            world.assertConverged();
          }
        ),
        {
          numRuns: profile.numRuns,
          seed,
          path,
          verbose: 2,
        }
      );
    },
    profile.testTimeoutMs
  );
});
