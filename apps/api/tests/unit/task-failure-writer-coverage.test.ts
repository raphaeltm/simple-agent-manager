import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('task failure writer coverage', () => {
  it.each([
    ['SAM dispatch', 'src/durable-objects/sam-session/tools/dispatch-task.ts', 2],
    ['SAM retry', 'src/durable-objects/sam-session/tools/retry-subtask.ts', 2],
    ['workspace MCP dispatch', 'src/routes/mcp/dispatch-tool.ts', 3],
    ['instant MCP dispatch', 'src/routes/mcp/dispatch-instant.ts', 1],
    ['MCP orchestration retry', 'src/routes/mcp/orchestration-tools.ts', 3],
    ['task run', 'src/routes/tasks/run.ts', 2],
    ['task submit', 'src/routes/tasks/submit.ts', 2],
    ['chat start', 'src/routes/chat-start.ts', 1],
  ])('%s routes every pre-run failure through the shared guarded helper', (_name, path, calls) => {
    const text = source(path);
    expect(text.match(/markTaskFailedIfNonTerminal\(/g)).toHaveLength(calls);
    expect(text).not.toMatch(/UPDATE tasks SET status\s*=\s*'failed'/);
  });

  it.each([
    ['TaskRunner', 'src/durable-objects/task-runner/state-machine.ts'],
    ['node provisioning', 'src/durable-objects/node-lifecycle-provisioning.ts'],
    ['session recovery', 'src/services/session-recovery-authority.ts'],
  ])('%s derives its atomic raw-SQL predicate from the canonical helper', (_name, path) => {
    const text = source(path);
    expect(text).toContain('taskStatusIsNonTerminalSql()');
    expect(text).toContain('...TERMINAL_STATUS_VALUES');
  });
});
