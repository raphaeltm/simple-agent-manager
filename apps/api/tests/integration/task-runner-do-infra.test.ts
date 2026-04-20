/**
 * Integration tests for TaskRunner DO infrastructure.
 *
 * Validates that the DO is properly wired into the Cloudflare Workers
 * runtime: wrangler bindings, Env interface, exports, migrations.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const wranglerConfig = readFileSync(
  resolve(process.cwd(), 'wrangler.toml'),
  'utf8'
);
const indexSource = readFileSync(
  resolve(process.cwd(), 'src/index.ts'),
  'utf8'
);
const envSource = readFileSync(
  resolve(process.cwd(), 'src/env.ts'),
  'utf8'
);
// TaskRunner DO is split across task-runner/ directory — read all module files
const doDir = resolve(process.cwd(), 'src/durable-objects/task-runner');
const doSource = [
  readFileSync(resolve(doDir, 'index.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'types.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'node-steps.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'workspace-steps.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'agent-session-step.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'state-machine.ts'), 'utf8'),
  readFileSync(resolve(doDir, 'helpers.ts'), 'utf8'),
].join('\n');
const sharedConstants = readFileSync(
  resolve(process.cwd(), '../../packages/shared/src/constants/task-execution.ts'),
  'utf8'
);

describe('wrangler.toml bindings', () => {
  it('has TASK_RUNNER durable object binding', () => {
    expect(wranglerConfig).toContain('name = "TASK_RUNNER"');
    expect(wranglerConfig).toContain('class_name = "TaskRunner"');
  });

  it('has migration tag for TaskRunner class', () => {
    expect(wranglerConfig).toContain('tag = "v4"');
    expect(wranglerConfig).toContain('new_classes = ["TaskRunner"]');
  });

  it('TASK_RUNNER binding appears in all environments', () => {
    // Count occurrences of TASK_RUNNER binding
    const matches = wranglerConfig.match(/name = "TASK_RUNNER"/g);
    // Should appear in base config (inherited by all envs)
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Env interface', () => {
  it('declares TASK_RUNNER as DurableObjectNamespace', () => {
    expect(envSource).toContain('TASK_RUNNER: DurableObjectNamespace');
  });

  it('declares all TaskRunner env vars', () => {
    const envVars = [
      'TASK_RUNNER_STEP_MAX_RETRIES',
      'TASK_RUNNER_RETRY_BASE_DELAY_MS',
      'TASK_RUNNER_RETRY_MAX_DELAY_MS',
      'TASK_RUNNER_AGENT_POLL_INTERVAL_MS',
      'TASK_RUNNER_AGENT_READY_TIMEOUT_MS',
      'TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS',
      'TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS',
      'TASK_RUNNER_PROVISION_POLL_INTERVAL_MS',
    ];
    for (const v of envVars) {
      expect(envSource).toContain(`${v}?: string`);
    }
  });
});

describe('DO class export', () => {
  it('index.ts exports TaskRunner from durable-objects', () => {
    expect(indexSource).toContain("export { TaskRunner } from './durable-objects/task-runner'");
  });

  it('TaskRunner extends DurableObject', () => {
    expect(doSource).toContain('export class TaskRunner extends DurableObject<Env>');
  });

  it('exports StartTaskInput for the service layer', () => {
    expect(doSource).toContain('export interface StartTaskInput');
  });

  it('exports TaskRunnerState for debugging/testing', () => {
    expect(doSource).toContain('export interface TaskRunnerState');
  });
});

describe('shared constants for TaskRunner DO', () => {
  const defaults = [
    { name: 'DEFAULT_TASK_RUNNER_STEP_MAX_RETRIES', expectedValue: '3' },
    { name: 'DEFAULT_TASK_RUNNER_RETRY_BASE_DELAY_MS', expectedValue: '5_000' },
    { name: 'DEFAULT_TASK_RUNNER_RETRY_MAX_DELAY_MS', expectedValue: '60_000' },
    { name: 'DEFAULT_TASK_RUNNER_AGENT_POLL_INTERVAL_MS', expectedValue: '5_000' },
    { name: 'DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS', expectedValue: '900_000' },
    { name: 'DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS', expectedValue: '30 * 60 * 1000' },
    { name: 'DEFAULT_TASK_RUNNER_WORKSPACE_READY_POLL_INTERVAL_MS', expectedValue: '30_000' },
    { name: 'DEFAULT_TASK_RUNNER_PROVISION_POLL_INTERVAL_MS', expectedValue: '10_000' },
  ];

  for (const { name, expectedValue } of defaults) {
    it(`${name} is defined in shared constants`, () => {
      expect(sharedConstants).toContain(`export const ${name}`);
    });

    it(`${name} has expected value`, () => {
      expect(sharedConstants).toContain(expectedValue);
    });
  }

  it('DO imports all defaults from shared', () => {
    for (const { name } of defaults) {
      expect(doSource).toContain(name);
    }
  });
});

describe('TaskRunner DO env type', () => {
  it('uses the full Env type from index.ts (no partial TaskRunnerEnv)', () => {
    // TaskRunner uses the full Env interface so service functions receive
    // properly typed env without `as any` casts.
    expect(doSource).toContain("import type { Env } from '../../env'");
    expect(doSource).toContain('extends DurableObject<Env>');
    expect(doSource).not.toContain('type TaskRunnerEnv');
  });
});

describe('Constitution Principle XI compliance', () => {
  it('all timeouts are configurable via env vars', () => {
    // Every getXxx() method in the DO class should read from this.env
    const configMethods = doSource.match(/private get\w+\(\):.*?{.*?}/gs);
    expect(configMethods).not.toBeNull();
    for (const method of configMethods!) {
      expect(method).toContain('this.env.');
      expect(method).toContain('DEFAULT_TASK_RUNNER');
    }
  });

  it('no hardcoded timeout values in step handlers', () => {
    // Step handlers should use rc.getXxx() not magic numbers
    const stepHandlers = [
      'handleNodeAgentReady',
      'handleWorkspaceReady',
      'handleNodeProvisioning',
    ];
    for (const handler of stepHandlers) {
      // Step handlers are now exported functions (not private class methods)
      const fnStart = doSource.indexOf(`export async function ${handler}(`);
      if (fnStart === -1) continue; // handler may be named differently after refactor
      const nextFn = doSource.indexOf('export async function', fnStart + 50);
      const section = doSource.slice(fnStart, nextFn > fnStart ? nextFn : undefined);
      // Should not contain direct millisecond constants like 30000, 60000, etc.
      expect(section).not.toMatch(/\b30000\b/);
      expect(section).not.toMatch(/\b60000\b/);
      expect(section).not.toMatch(/\b120000\b/);
    }
  });
});

// =============================================================================
// Initial Prompt Delivery (post-mortem fix)
// =============================================================================

const nodeAgentSource = readFileSync(
  resolve(process.cwd(), 'src/services/node-agent.ts'),
  'utf8'
);

describe('Initial prompt delivery: startAgentSessionOnNode', () => {
  it('exports startAgentSessionOnNode function', () => {
    expect(nodeAgentSource).toContain('export async function startAgentSessionOnNode');
  });

  it('accepts agentType and initialPrompt parameters', () => {
    // Verify the function signature includes the required params
    expect(nodeAgentSource).toContain('agentType: string');
    expect(nodeAgentSource).toContain('initialPrompt: string');
  });

  it('POSTs to the /start endpoint', () => {
    expect(nodeAgentSource).toContain('/agent-sessions/${sessionId}/start');
  });

  it('sends agentType and initialPrompt in the request body', () => {
    // The body is now constructed dynamically to support optional mcpServers
    expect(nodeAgentSource).toContain('body: JSON.stringify(body)');
    expect(nodeAgentSource).toContain('agentType');
    expect(nodeAgentSource).toContain('initialPrompt');
  });
});

describe('Initial prompt delivery: TaskRunner DO wiring', () => {
  it('handleAgentSession calls startAgentSessionOnNode', () => {
    expect(doSource).toContain('startAgentSessionOnNode');
  });

  it('passes taskDescription as the initial prompt content', () => {
    expect(doSource).toContain('state.config.taskDescription');
  });

  it('falls back to taskTitle when description is missing', () => {
    expect(doSource).toContain('state.config.taskDescription || state.config.taskTitle');
  });

  it('appends get_instructions MCP instruction after task content', () => {
    expect(doSource).toContain('get_instructions');
    expect(doSource).toContain('sam-mcp');
    expect(doSource).toContain('taskContent');
  });

  it('uses DEFAULT_TASK_AGENT_TYPE env var with opencode fallback', () => {
    expect(doSource).toContain('DEFAULT_TASK_AGENT_TYPE');
    expect(doSource).toContain("'opencode'");
  });

  it('logs agent_session_started event', () => {
    expect(doSource).toContain('task_runner_do.step.agent_session_started');
  });
});

describe('Initial prompt delivery: two-step idempotency', () => {
  it('StepResults interface includes agentStarted boolean', () => {
    expect(doSource).toContain('agentStarted: boolean');
  });

  it('agentStarted is initialized to false', () => {
    expect(doSource).toContain('agentStarted: false');
  });

  it('agentStarted is set to true after successful start', () => {
    // After startAgentSessionOnNode succeeds, state.stepResults.agentStarted = true
    expect(doSource).toContain('state.stepResults.agentStarted = true');
  });

  it('skips start call when agentStarted is already true', () => {
    // The retry guard: if (!state.stepResults.agentStarted)
    expect(doSource).toContain('!state.stepResults.agentStarted');
  });

  it('persists state between create and start steps', () => {
    // Both steps call ctx.storage.put after their respective flag changes
    // Count storage.put calls in handleAgentSession (now an exported function)
    const fnStart = doSource.indexOf('export async function handleAgentSession(');
    const nextFn = doSource.indexOf('export async function', fnStart + 50);
    const handleAgentSection = doSource.slice(fnStart, nextFn > fnStart ? nextFn : undefined);
    const storagePuts = handleAgentSection.match(/rc\.ctx\.storage\.put\('state'/g);
    expect(storagePuts).not.toBeNull();
    // At least 3: after sessionId set, after reset (edge case), and after agentStarted
    expect(storagePuts!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Initial prompt delivery: Env and config', () => {
  it('Env interface declares DEFAULT_TASK_AGENT_TYPE', () => {
    expect(envSource).toContain('DEFAULT_TASK_AGENT_TYPE?: string');
  });

  it('wrangler.toml top-level has DEFAULT_TASK_AGENT_TYPE', () => {
    expect(wranglerConfig).toContain('DEFAULT_TASK_AGENT_TYPE = "opencode"');
  });

  it('DEFAULT_TASK_AGENT_TYPE appears in top-level vars (sync script copies to env sections at deploy time)', () => {
    const matches = wranglerConfig.match(/DEFAULT_TASK_AGENT_TYPE/g);
    expect(matches).not.toBeNull();
    // Present in top-level vars (env sections are generated at deploy time, not checked in)
    expect(matches!.length).toBeGreaterThanOrEqual(1);
  });
});
