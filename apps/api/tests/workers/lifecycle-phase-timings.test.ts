/**
 * Insights slice T: lifecycle phase timings are stored, not only logged. Every case enters
 * through the real VM-agent callback route (rule 62): a callback JWT, the real Worker routing,
 * real D1 with the shipped migrations. Attribution (task, skill, profile) is resolved inside the
 * INSERT, so each case also proves that resolution against a real SQL engine, with a
 * foreign-project task and a foreign profile beside the owner's (rule 11).
 */
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { signCallbackToken, signNodeCallbackToken } from '../../src/services/jwt';
import { runLifecycleLatencyDailyEvaluation } from '../../src/services/lifecycle-latency/daily-evaluation';
import { LIFECYCLE_LATENCY_DEFAULTS } from '../../src/services/lifecycle-latency/defaults';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const DAY = 86_400_000;

interface StoredRow {
  operation: string;
  phase: string;
  outcome: string;
  duration_ms: number;
  project_id: string | null;
  workspace_id: string | null;
  node_id: string | null;
  chat_session_id: string | null;
  task_id: string | null;
  skill_id: string | null;
  agent_profile_id: string | null;
  created_at: number;
}

async function rows(where: string, ...bindings: string[]): Promise<StoredRow[]> {
  const result = await env.DATABASE.prepare(
    `SELECT * FROM lifecycle_phase_timings WHERE ${where} ORDER BY id`
  )
    .bind(...bindings)
    .all<StoredRow>();
  return result.results ?? [];
}

async function seedProfile(id: string, projectId: string | null, userId: string): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claude-code', datetime('now'), datetime('now'))`
  )
    .bind(id, projectId, userId, `Profile ${id}`)
    .run();
}

async function seedTaskWithSetup(
  taskId: string,
  projectId: string,
  userId: string,
  workspaceId: string,
  setup: { skillId: string | null; profileHint: string | null }
): Promise<void> {
  await seedTask(taskId, projectId, userId, { workspaceId, status: 'in_progress' });
  if (setup.skillId) {
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO skills (id, project_id, user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(setup.skillId, projectId, userId, `Skill ${setup.skillId}`)
      .run();
  }
  await env.DATABASE.prepare('UPDATE tasks SET skill_id = ?, agent_profile_hint = ? WHERE id = ?')
    .bind(setup.skillId, setup.profileHint, taskId)
    .run();
}

async function postWorkspaceTimings(
  workspaceId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const token = await signCallbackToken(workspaceId, env as unknown as Env, {
    callbackGeneration: null,
  });
  return SELF.fetch(
    `https://api.test.example.com/api/workspaces/${workspaceId}/lifecycle-timings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

describe('lifecycle phase timings storage', () => {
  it('stores one attributed row per bounded phase from a workspace callback', async () => {
    const user = 'user-lpt-owner';
    await seedUser(user);
    await seedInstallation('inst-lpt', user);
    await seedProject('proj-lpt', user, 'inst-lpt');
    await seedNode('node-lpt', user);
    await seedWorkspace('ws-lpt', 'node-lpt', user, {
      projectId: 'proj-lpt',
      status: 'creating',
      chatSessionId: 'chat-lpt',
    });
    await seedProfile('profile-lpt', 'proj-lpt', user);
    await seedTaskWithSetup('task-lpt', 'proj-lpt', user, 'ws-lpt', {
      skillId: 'skill-lpt',
      profileHint: 'profile-lpt',
    });

    const response = await postWorkspaceTimings('ws-lpt', {
      operation: 'workspace',
      phases: [
        { phase: 'git_clone', durationMs: 4200 },
        { phase: 'devcontainer_up', durationMs: 61000 },
        { phase: 'sam_env', durationMs: 15 },
        // Dropped by the bound: unknown label, negative duration, extra fields.
        { phase: '/etc/passwd', durationMs: 1 },
        { phase: 'docker', durationMs: -5 },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(200);

    const stored = await rows('workspace_id = ?', 'ws-lpt');
    expect(stored.map((row) => [row.phase, row.duration_ms])).toEqual([
      ['git_clone', 4200],
      ['devcontainer_up', 61000],
      ['platform_environment', 15],
    ]);
    for (const row of stored) {
      expect(row).toMatchObject({
        operation: 'workspace',
        outcome: 'success',
        project_id: 'proj-lpt',
        node_id: 'node-lpt',
        chat_session_id: 'chat-lpt',
        task_id: 'task-lpt',
        skill_id: 'skill-lpt',
        agent_profile_id: 'profile-lpt',
      });
      expect(Math.abs(row.created_at - Date.now())).toBeLessThan(60_000);
    }
  });

  it('never attributes a foreign project task or a profile the task owner cannot use', async () => {
    const owner = 'user-lpt-attack-owner';
    const other = 'user-lpt-attack-other';
    await seedUser(owner);
    await seedUser(other);
    await seedInstallation('inst-lpt-a', owner);
    await seedInstallation('inst-lpt-b', other);
    await seedProject('proj-lpt-a', owner, 'inst-lpt-a');
    await seedProject('proj-lpt-b', other, 'inst-lpt-b');
    await seedNode('node-lpt-a', owner);
    await seedWorkspace('ws-lpt-a', 'node-lpt-a', owner, {
      projectId: 'proj-lpt-a',
      status: 'running',
      chatSessionId: 'chat-lpt-a',
    });
    // A task in ANOTHER project that claims this workspace id must not be attributed.
    await seedTaskWithSetup('task-lpt-foreign', 'proj-lpt-b', other, 'ws-lpt-a', {
      skillId: 'skill-foreign',
      profileHint: null,
    });
    // The owner's own task names a profile from another user's global set: not a usable id.
    await seedProfile('profile-lpt-foreign-global', null, other);
    await seedTaskWithSetup('task-lpt-own', 'proj-lpt-a', owner, 'ws-lpt-a', {
      skillId: 'skill-own',
      profileHint: 'profile-lpt-foreign-global',
    });
    // The foreign task is the newest, so only the project predicate keeps it out.
    await env.DATABASE.prepare(
      "UPDATE tasks SET created_at = datetime('now', '+1 hour') WHERE id = 'task-lpt-foreign'"
    ).run();

    const response = await postWorkspaceTimings('ws-lpt-a', {
      operation: 'sleep',
      outcome: 'error',
      phases: [{ phase: 'home_capture', durationMs: 900 }],
    });
    expect(response.status).toBe(200);

    const [row] = await rows('workspace_id = ?', 'ws-lpt-a');
    expect(row).toMatchObject({
      operation: 'sleep',
      outcome: 'error',
      project_id: 'proj-lpt-a',
      task_id: 'task-lpt-own',
      skill_id: 'skill-own',
      agent_profile_id: null,
    });

    // Owner control: the owner's own global profile IS attributed.
    await seedProfile('profile-lpt-own-global', null, owner);
    await env.DATABASE.prepare('UPDATE tasks SET agent_profile_hint = ? WHERE id = ?')
      .bind('profile-lpt-own-global', 'task-lpt-own')
      .run();
    await postWorkspaceTimings('ws-lpt-a', {
      operation: 'wake',
      phases: [{ phase: 'home_restore', durationMs: 300 }],
    });
    const [wake] = await rows('workspace_id = ? AND operation = ?', 'ws-lpt-a', 'wake');
    expect(wake).toMatchObject({
      task_id: 'task-lpt-own',
      agent_profile_id: 'profile-lpt-own-global',
    });
  });

  it('stores provision rows from the node ready callback with the node id only', async () => {
    const user = 'user-lpt-node';
    await seedUser(user);
    await seedNode('node-lpt-ready', user, { status: 'creating' });
    const token = await signNodeCallbackToken('node-lpt-ready', env as unknown as Env, {
      callbackGeneration: null,
    });
    const response = await SELF.fetch(
      'https://api.test.example.com/api/nodes/node-lpt-ready/ready',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentVersion: 'test',
          provisionTimings: [
            { phase: 'packages', durationMs: 12000 },
            { phase: 'docker', durationMs: 8000 },
          ],
        }),
      }
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const stored = await rows('node_id = ?', 'node-lpt-ready');
    expect(stored.map((row) => [row.operation, row.phase, row.duration_ms])).toEqual([
      ['provision', 'packages', 12000],
      ['provision', 'docker', 8000],
    ]);
    expect(stored.every((row) => row.project_id === null && row.workspace_id === null)).toBe(true);
  });

  it('purges rows past lifecycleLatency.retentionDays in the daily evaluation', async () => {
    const now = Date.now();
    const retentionMs = LIFECYCLE_LATENCY_DEFAULTS.retentionDays * DAY;
    await env.DATABASE.batch(
      [now - retentionMs - DAY, now - retentionMs - 1, now - DAY].map((createdAt, index) =>
        env.DATABASE.prepare(
          `INSERT INTO lifecycle_phase_timings
             (operation, phase, outcome, duration_ms, workspace_id, created_at)
           VALUES ('workspace', 'git_clone', 'success', 10, ?, ?)`
        ).bind(`ws-lpt-purge-${index}`, createdAt)
      )
    );
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    expect(result.purgedPhaseTimings).toBe(2);
    const remaining = await rows("workspace_id LIKE 'ws-lpt-purge-%'");
    expect(remaining.map((row) => row.workspace_id)).toEqual(['ws-lpt-purge-2']);
  });

  it('still accepts the callback, and still purges episodes, when the timings table is unusable', async () => {
    const user = 'user-lpt-broken';
    await seedUser(user);
    await seedNode('node-lpt-broken', user);
    await seedWorkspace('ws-lpt-broken', 'node-lpt-broken', user, { status: 'running' });
    await env.DATABASE.prepare('ALTER TABLE lifecycle_phase_timings RENAME TO lpt_hidden').run();
    try {
      const response = await postWorkspaceTimings('ws-lpt-broken', {
        operation: 'workspace',
        phases: [{ phase: 'git_clone', durationMs: 5 }],
      });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ accepted: true });

      const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date());
      expect(result.purgedPhaseTimings).toBeNull();
      // The other purge and the evaluation itself still ran.
      expect(result.purgedEpisodes).toBe(0);
      expect(result.evaluations.length).toBeGreaterThan(0);
    } finally {
      await env.DATABASE.prepare('ALTER TABLE lpt_hidden RENAME TO lifecycle_phase_timings').run();
    }
    // Liveness control: with the table back, the same callback stores its row.
    await postWorkspaceTimings('ws-lpt-broken', {
      operation: 'workspace',
      phases: [{ phase: 'git_clone', durationMs: 6 }],
    });
    expect((await rows('workspace_id = ?', 'ws-lpt-broken')).map((row) => row.duration_ms)).toEqual(
      [6]
    );
  });
});
