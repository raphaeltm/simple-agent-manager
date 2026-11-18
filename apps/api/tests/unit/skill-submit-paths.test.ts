import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function apiSrc(path: string) {
  return readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
}

describe('skill submit path source contracts', () => {
  it('user task submit resolves skill/profile settings and persists skill metadata', () => {
    const submit = [
      apiSrc('services/submit-task-implementation.ts'),
      apiSrc('services/submit-vm-task.ts'),
    ].join('\n');
    const placementResolver = apiSrc('services/placement-resolver.ts');
    expect(submit).toContain('resolveSkillProfile');
    expect(submit).toContain('body.skillId');
    expect(submit).toContain('resolveTaskStartPlacement');
    expect(submit).toContain(
      'skill: resolvedProfile?.skillId ? resolvedProfile.resourceRequirementsJson : null'
    );
    expect(placementResolver).toContain('skillId: profile?.skillId ?? undefined');
    expect(submit).toContain('skillId: resolvedProfile?.skillId ?? null');
    expect(submit).toContain('skillHint: body.skillId ?? null');
  });

  // Trigger skill propagation is exercised through real D1 in trigger-submit-capacity-pools.test.ts.

  it('SAM dispatch_task accepts skillId, resolves it, and stores skill metadata', () => {
    const dispatchTask = apiSrc('durable-objects/sam-session/tools/dispatch-task.ts');
    expect(dispatchTask).toContain('skillId: {');
    expect(dispatchTask).toContain('skillId?: string');
    expect(dispatchTask).toContain('resolveSkillProfile');
    expect(dispatchTask).toContain('input.skillId');
    const storage = apiSrc('durable-objects/sam-session/tools/dispatch-task-storage.ts');
    expect(dispatchTask).toContain("from './dispatch-task-storage'");
    expect(dispatchTask).toMatch(/await insertSamDispatchedTask\(\s+env,\s+\[/);
    expect(storage).toContain('export function insertSamDispatchedTask(');
    expect(storage).toContain('INSERT INTO tasks');
    expect(storage).toContain('task_mode, agent_profile_hint, skill_id, skill_hint, mission_id');
    expect(storage).toContain('.bind(...values,');
    expect(dispatchTask).toMatch(
      /resolvedProfile\?\.skillId \?\? null,\s+input\.skillId \?\? null/
    );
  });

  it('retry_subtask preserves original skill id and hint when creating the retry task', () => {
    const retrySubtask = apiSrc('durable-objects/sam-session/tools/retry-subtask.ts');
    expect(retrySubtask).toContain('skillId: schema.tasks.skillId');
    expect(retrySubtask).toContain('skillHint: schema.tasks.skillHint');
    expect(retrySubtask).toContain('resolveSkillProfile');
    expect(retrySubtask).toContain('original.skillId');
    expect(retrySubtask).toContain('skill_id, skill_hint');
    expect(retrySubtask).toContain('original.skillHint ?? original.skillId ?? null');
  });

  it('HTTP MCP dispatch_task validates optional skillId and propagates it into the task record', () => {
    const mcpDispatch = [
      apiSrc('routes/mcp/dispatch-tool.ts'),
      apiSrc('routes/mcp/dispatch-tool-params.ts'),
    ].join('\n');
    const toolDefinition = apiSrc('routes/mcp/tool-definitions-task-tools.ts');
    expect(toolDefinition).toContain('skillId: {');
    expect(mcpDispatch).toContain('params.skillId');
    expect(mcpDispatch).toContain('skillId must be a non-empty string');
    expect(mcpDispatch).toContain('resolveSkillProfile');
    const storage = apiSrc('routes/mcp/dispatch-task-storage.ts');
    expect(mcpDispatch).toContain("from './dispatch-task-storage'");
    expect(mcpDispatch).toMatch(/await insertDispatchedTask\(\s+env,\s+\[/);
    expect(storage).toContain('export function insertDispatchedTask(');
    expect(storage).toContain('INSERT INTO tasks');
    expect(storage).toContain('task_mode, agent_profile_hint, skill_id, skill_hint, mission_id');
    expect(storage).toContain('...values,');
    expect(mcpDispatch).toMatch(/resolvedProfile\?\.skillId \?\? null,\s+skillId \?\? null/);
  });
});
