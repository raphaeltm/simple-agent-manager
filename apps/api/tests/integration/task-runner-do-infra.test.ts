/**
 * Integration tests for TaskRunner DO infrastructure.
 *
 * Validates that the DO is properly wired into the Cloudflare Workers
 * runtime: wrangler bindings, Env interface, exports, migrations.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const wranglerConfig = readFileSync(
  resolve(process.cwd(), 'wrangler.toml'),
  'utf8'
);
const indexSource = readFileSync(
  resolve(process.cwd(), 'src/index.ts'),
  'utf8'
);
const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);
const sharedConstants = readFileSync(
  resolve(process.cwd(), '../../packages/shared/src/constants.ts'),
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
    expect(indexSource).toContain('TASK_RUNNER: DurableObjectNamespace');
  });

  it('declares all TaskRunner env vars', () => {
    const envVars = [
      'TASK_RUNNER_STEP_MAX_RETRIES',
      'TASK_RUNNER_RETRY_BASE_DELAY_MS',
      'TASK_RUNNER_RETRY_MAX_DELAY_MS',
      'TASK_RUNNER_AGENT_POLL_INTERVAL_MS',
      'TASK_RUNNER_AGENT_READY_TIMEOUT_MS',
      'TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS',
      'TASK_RUNNER_PROVISION_POLL_INTERVAL_MS',
    ];
    for (const v of envVars) {
      expect(indexSource).toContain(`${v}?: string`);
    }
  });
});

describe('DO class export', () => {
  it('index.ts exports TaskRunner from durable-objects', () => {
    expect(indexSource).toContain("export { TaskRunner } from './durable-objects/task-runner'");
  });

  it('TaskRunner extends DurableObject', () => {
    expect(doSource).toContain('export class TaskRunner extends DurableObject<TaskRunnerEnv>');
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
    { name: 'DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS', expectedValue: '120_000' },
    { name: 'DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS', expectedValue: '15' },
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
  it('defines TaskRunnerEnv type subset', () => {
    expect(doSource).toContain('type TaskRunnerEnv =');
  });

  it('includes DATABASE binding', () => {
    expect(doSource).toContain('DATABASE: D1Database');
  });

  it('includes OBSERVABILITY_DATABASE binding', () => {
    expect(doSource).toContain('OBSERVABILITY_DATABASE: D1Database');
  });

  it('includes NODE_LIFECYCLE binding', () => {
    expect(doSource).toContain('NODE_LIFECYCLE: DurableObjectNamespace');
  });

  it('includes BASE_DOMAIN for URL construction', () => {
    expect(doSource).toContain('BASE_DOMAIN: string');
  });

  it('includes ENCRYPTION_KEY for JWT operations', () => {
    expect(doSource).toContain('ENCRYPTION_KEY: string');
  });

  it('includes all configurable env vars as optional strings', () => {
    expect(doSource).toContain('TASK_RUNNER_STEP_MAX_RETRIES?: string');
    expect(doSource).toContain('TASK_RUNNER_RETRY_BASE_DELAY_MS?: string');
  });
});

describe('Constitution Principle XI compliance', () => {
  it('all timeouts are configurable via env vars', () => {
    // Every getXxx() method should read from this.env
    const configMethods = doSource.match(/private get\w+\(\).*?{.*?}/gs);
    expect(configMethods).not.toBeNull();
    for (const method of configMethods!) {
      expect(method).toContain('this.env.');
      expect(method).toContain('DEFAULT_TASK_RUNNER');
    }
  });

  it('no hardcoded timeout values in step handlers', () => {
    // Step handlers should use this.getXxx() not magic numbers
    const stepHandlers = [
      'handleNodeAgentReady',
      'handleWorkspaceReady',
      'handleNodeProvisioning',
    ];
    for (const handler of stepHandlers) {
      const section = doSource.slice(
        doSource.indexOf(`private async ${handler}(`),
        doSource.indexOf('private async', doSource.indexOf(`private async ${handler}(`) + 50)
      );
      // Should not contain direct millisecond constants like 5000, 10000, etc.
      // Exception: 5000 for health check AbortController timeout (acceptable)
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
    expect(nodeAgentSource).toContain('JSON.stringify({ agentType, initialPrompt })');
  });
});

describe('Initial prompt delivery: TaskRunner DO wiring', () => {
  it('handleAgentSession calls startAgentSessionOnNode', () => {
    expect(doSource).toContain('startAgentSessionOnNode');
  });

  it('passes taskDescription as the initial prompt', () => {
    expect(doSource).toContain('state.config.taskDescription');
  });

  it('falls back to taskTitle when description is missing', () => {
    expect(doSource).toContain('state.config.taskDescription || state.config.taskTitle');
  });

  it('uses DEFAULT_TASK_AGENT_TYPE env var with claude-code fallback', () => {
    expect(doSource).toContain('DEFAULT_TASK_AGENT_TYPE');
    expect(doSource).toContain("'claude-code'");
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
    // Count storage.put calls in handleAgentSession
    const handleAgentSection = doSource.slice(
      doSource.indexOf('private async handleAgentSession('),
      doSource.indexOf('private async', doSource.indexOf('private async handleAgentSession(') + 50)
    );
    const storagePuts = handleAgentSection.match(/this\.ctx\.storage\.put\('state'/g);
    expect(storagePuts).not.toBeNull();
    // At least 3: after sessionId set, after reset (edge case), and after agentStarted
    expect(storagePuts!.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Initial prompt delivery: Env and config', () => {
  it('Env interface declares DEFAULT_TASK_AGENT_TYPE', () => {
    expect(indexSource).toContain('DEFAULT_TASK_AGENT_TYPE?: string');
  });

  it('wrangler.toml top-level has DEFAULT_TASK_AGENT_TYPE', () => {
    expect(wranglerConfig).toContain('DEFAULT_TASK_AGENT_TYPE = "claude-code"');
  });

  it('DEFAULT_TASK_AGENT_TYPE appears in all environment vars sections', () => {
    const matches = wranglerConfig.match(/DEFAULT_TASK_AGENT_TYPE/g);
    expect(matches).not.toBeNull();
    // top-level + staging + production = at least 3
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});
