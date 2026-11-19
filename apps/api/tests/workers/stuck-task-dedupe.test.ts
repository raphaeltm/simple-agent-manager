import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { recordLiveRuntimePreservation } from '../../src/scheduled/stuck-task-live-runtime';

describe('stuck-task preservation dedupe on real D1', () => {
  it('persists one row for the longest live basis and separates different keys', async () => {
    const taskId = `dedupe-${crypto.randomUUID()}`;
    const input = {
      task: {
        id: taskId,
        project_id: 'project-dedupe',
        user_id: 'user-dedupe',
        workspace_id: null,
        chat_session_id: null,
      },
      liveness: {
        live: true,
        conclusive: true,
        reason: 'task_acp_session_live',
        nodeId: null,
        activeAcpSessionId: 'agent-dedupe',
        evidence: {
          workState: 'prompt_turn_unproven',
          acpHeartbeatAgeMs: 0,
          lastActivityAgeMs: 600_000,
          promptStartedAgeMs: 600_000,
          runtimeWorkProgressAgeMs: null,
        },
      },
      executionMs: 600_000,
      maxExecutionMs: 300_000,
      absoluteCeilingMs: 86_400_000,
      runtimeGenerationMs: 600_000,
    } as Parameters<typeof recordLiveRuntimePreservation>[1];
    for (let tick = 0; tick < 3; tick++)
      await recordLiveRuntimePreservation(env as unknown as Env, input);
    const first = await env.OBSERVABILITY_DATABASE.prepare(
      'SELECT context FROM platform_errors WHERE task_id = ?'
    )
      .bind(taskId)
      .all<{ context: string }>();
    expect(first.results).toHaveLength(1);
    expect(JSON.parse(first.results[0]!.context).preservationKey).toBe(
      'task_acp_session_live:prompt_turn_unproven'
    );
    for (const reason of ['task_prompt_turn_active', 'literal_%_\\quoted"', 'literal_%_\\quoted"-suffix']) {
      input.liveness.reason = reason;
      await recordLiveRuntimePreservation(env as unknown as Env, input);
      await recordLiveRuntimePreservation(env as unknown as Env, input);
    }
    expect(
      (
        await env.OBSERVABILITY_DATABASE.prepare('SELECT id FROM platform_errors WHERE task_id = ?')
          .bind(taskId)
          .all()
      ).results
    ).toHaveLength(4);
  });
});
