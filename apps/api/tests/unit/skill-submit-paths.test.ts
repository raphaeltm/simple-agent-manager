import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function apiSrc(path: string) {
  return readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
}

describe('skill submit path source contracts', () => {
  it('user task submit resolves skill/profile settings and persists skill metadata', () => {
    const submit = apiSrc('routes/tasks/submit.ts');
    expect(submit).toContain('resolveSkillProfile');
    expect(submit).toContain('body.skillId');
    expect(submit).toContain('skillId: resolvedProfile?.skillId ?? undefined');
    expect(submit).toContain('skillId: resolvedProfile?.skillId ?? null');
    expect(submit).toContain('skillHint: body.skillId ?? null');
  });

  it('trigger submit resolves stored skill id and persists skill metadata', () => {
    const triggerSubmit = apiSrc('services/trigger-submit.ts');
    expect(triggerSubmit).toContain('resolveSkillProfile');
    expect(triggerSubmit).toContain('input.skillId');
    expect(triggerSubmit).toContain('skillId: resolvedProfile?.skillId ?? undefined');
    expect(triggerSubmit).toContain('skillId: resolvedProfile?.skillId ?? null');
    expect(triggerSubmit).toContain('skillHint: input.skillId');
  });

  it('SAM dispatch_task accepts skillId, resolves it, and stores skill metadata', () => {
    const dispatchTask = apiSrc('durable-objects/sam-session/tools/dispatch-task.ts');
    expect(dispatchTask).toContain('skillId: {');
    expect(dispatchTask).toContain('skillId?: string');
    expect(dispatchTask).toContain('resolveSkillProfile');
    expect(dispatchTask).toContain('input.skillId');
    expect(dispatchTask).toContain('skill_id, skill_hint');
    expect(dispatchTask).toContain('resolvedProfile?.skillId ?? null, input.skillId ?? null');
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
    const mcpDispatch = apiSrc('routes/mcp/dispatch-tool.ts');
    const toolDefinition = apiSrc('routes/mcp/tool-definitions-task-tools.ts');
    expect(toolDefinition).toContain('skillId: {');
    expect(mcpDispatch).toContain('params.skillId');
    expect(mcpDispatch).toContain('skillId must be a non-empty string');
    expect(mcpDispatch).toContain('resolveSkillProfile');
    expect(mcpDispatch).toContain('skill_id, skill_hint');
    expect(mcpDispatch).toMatch(/resolvedProfile\?\.skillId \?\? null,\s+skillId \?\? null/);
  });
});
