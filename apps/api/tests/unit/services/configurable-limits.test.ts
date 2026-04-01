/**
 * Tests for configurable limits introduced in the relax-system-limits PR.
 *
 * The PR makes several previously hardcoded limits configurable via env vars:
 * - MAX_TASK_MESSAGE_LENGTH    (tasks/submit.ts — was 2000, default now 16000)
 * - MAX_MESSAGES_PER_BATCH    (workspaces/runtime.ts — was hardcoded 100)
 * - MAX_MESSAGES_PAYLOAD_BYTES (workspaces/runtime.ts — was hardcoded 256*1024)
 * - MAX_ACP_PROMPT_BYTES      (projects/acp-sessions.ts — was 65536, now 262144)
 * - MAX_ACP_CONTEXT_BYTES     (projects/acp-sessions.ts — was 65536, now 262144)
 * - MAX_ACTIVITY_MESSAGE_LENGTH (mcp.ts — was 500, default now 2000)
 * - MAX_LOG_MESSAGE_LENGTH    (mcp.ts — was 200, default now 1000)
 * - MAX_OUTPUT_SUMMARY_LENGTH (mcp.ts — was 2000, still 2000 but now configurable)
 * - MAX_AGENT_SESSION_LABEL_LENGTH (workspaces/agent-sessions.ts — was hardcoded 50)
 *
 * Also covers:
 * - Rate limit default changes (WORKSPACE_CREATE: 10→30, CREDENTIAL_UPDATE: 5→30)
 * - Removal of maxWorkspacesPerNode from RuntimeLimits
 * - New default values for maxProjectsPerUser (25→100) and maxTaskDependenciesPerTask (25→50)
 */
import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect,it } from 'vitest';

import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { getRuntimeLimits } from '../../../src/services/limits';

// =============================================================================
// getRuntimeLimits — maxWorkspacesPerNode removal
// =============================================================================

describe('RuntimeLimits — maxWorkspacesPerNode removed', () => {
  it('getRuntimeLimits no longer returns maxWorkspacesPerNode', () => {
    const limits = getRuntimeLimits({});
    expect((limits as Record<string, unknown>).maxWorkspacesPerNode).toBeUndefined();
  });

  it('getRuntimeLimits returns updated maxProjectsPerUser default of 100', () => {
    expect(getRuntimeLimits({}).maxProjectsPerUser).toBe(100);
  });

  it('getRuntimeLimits returns updated maxTaskDependenciesPerTask default of 50', () => {
    expect(getRuntimeLimits({}).maxTaskDependenciesPerTask).toBe(50);
  });

  it('ENV override for MAX_PROJECTS_PER_USER still works after removal of maxWorkspacesPerNode', () => {
    const limits = getRuntimeLimits({ MAX_PROJECTS_PER_USER: '200' });
    expect(limits.maxProjectsPerUser).toBe(200);
  });

  it('ENV override for MAX_TASK_DEPENDENCIES_PER_TASK still works', () => {
    const limits = getRuntimeLimits({ MAX_TASK_DEPENDENCIES_PER_TASK: '100' });
    expect(limits.maxTaskDependenciesPerTask).toBe(100);
  });
});

// =============================================================================
// Rate limit defaults — updated values
// =============================================================================

describe('DEFAULT_RATE_LIMITS — updated values', () => {
  it('WORKSPACE_CREATE default is now 30 (was 10)', () => {
    expect(DEFAULT_RATE_LIMITS.WORKSPACE_CREATE).toBe(30);
  });

  it('CREDENTIAL_UPDATE default is now 30 (was 5)', () => {
    expect(DEFAULT_RATE_LIMITS.CREDENTIAL_UPDATE).toBe(30);
  });

  it('TERMINAL_TOKEN default is unchanged at 60', () => {
    expect(DEFAULT_RATE_LIMITS.TERMINAL_TOKEN).toBe(60);
  });

  it('ANONYMOUS default is unchanged at 100', () => {
    expect(DEFAULT_RATE_LIMITS.ANONYMOUS).toBe(100);
  });

  it('CLIENT_ERRORS default is unchanged at 200', () => {
    expect(DEFAULT_RATE_LIMITS.CLIENT_ERRORS).toBe(200);
  });
});

// =============================================================================
// Source contract: MAX_TASK_MESSAGE_LENGTH configurable
// =============================================================================

describe('task submit — configurable MAX_TASK_MESSAGE_LENGTH', () => {
  const submitSource = readFileSync(
    resolve(process.cwd(), 'src/routes/tasks/submit.ts'),
    'utf8'
  );

  it('reads max message length from MAX_TASK_MESSAGE_LENGTH env var', () => {
    expect(submitSource).toContain('c.env.MAX_TASK_MESSAGE_LENGTH');
  });

  it('has a DEFAULT_MAX_MESSAGE_LENGTH constant (not hardcoded inline)', () => {
    expect(submitSource).toContain('DEFAULT_MAX_MESSAGE_LENGTH');
  });

  it('default is 16000 characters (relaxed from 2000)', () => {
    // The default constant value should be 16_000
    expect(submitSource).toContain('16_000');
  });

  it('falls back to default when env var is absent', () => {
    // Uses parsePositiveInt helper for safe fallback
    expect(submitSource).toContain('parsePositiveInt(c.env.MAX_TASK_MESSAGE_LENGTH, DEFAULT_MAX_MESSAGE_LENGTH)');
  });

  it('error message references the configurable limit variable', () => {
    expect(submitSource).toContain('`Message must be ${maxMessageLength} characters or less`');
  });
});

// =============================================================================
// Source contract: MAX_MESSAGES_PER_BATCH configurable
// =============================================================================

describe('workspace messages — configurable MAX_MESSAGES_PER_BATCH', () => {
  const runtimeSource = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/runtime.ts'),
    'utf8'
  );

  it('reads batch limit from MAX_MESSAGES_PER_BATCH env var', () => {
    expect(runtimeSource).toContain('c.env.MAX_MESSAGES_PER_BATCH');
  });

  it('falls back to 100 when env var is absent', () => {
    expect(runtimeSource).toContain("parsePositiveInt(c.env.MAX_MESSAGES_PER_BATCH as string, 100)");
  });

  it('uses maxMessagesPerBatch variable in the comparison (not hardcoded 100)', () => {
    expect(runtimeSource).toContain('body.messages.length > maxMessagesPerBatch');
  });

  it('error message references the configurable variable', () => {
    expect(runtimeSource).toContain('`Maximum ${maxMessagesPerBatch} messages per batch`');
  });
});

// =============================================================================
// Source contract: MAX_MESSAGES_PAYLOAD_BYTES configurable
// =============================================================================

describe('workspace messages — configurable MAX_MESSAGES_PAYLOAD_BYTES', () => {
  const runtimeSource = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/runtime.ts'),
    'utf8'
  );

  it('reads payload size limit from MAX_MESSAGES_PAYLOAD_BYTES env var', () => {
    expect(runtimeSource).toContain('c.env.MAX_MESSAGES_PAYLOAD_BYTES');
  });

  it('defaults to 256*1024 (256 KB) when env var is absent', () => {
    expect(runtimeSource).toContain('parsePositiveInt(c.env.MAX_MESSAGES_PAYLOAD_BYTES as string, 256 * 1024)');
  });

  it('uses configurable maxPayloadBytes in the comparison', () => {
    expect(runtimeSource).toContain('contentLength > maxPayloadBytes');
  });
});

// =============================================================================
// Source contract: MAX_ACP_PROMPT_BYTES configurable (was 65536, now 262144)
// =============================================================================

describe('ACP sessions — configurable MAX_ACP_PROMPT_BYTES', () => {
  const acpSource = readFileSync(
    resolve(process.cwd(), 'src/routes/projects/acp-sessions.ts'),
    'utf8'
  );

  it('reads prompt size limit from MAX_ACP_PROMPT_BYTES env var', () => {
    expect(acpSource).toContain('c.env.MAX_ACP_PROMPT_BYTES');
  });

  it('defaults to 262144 bytes (256 KB, relaxed from 64 KB)', () => {
    expect(acpSource).toContain('262144');
  });

  it('uses configurable maxPromptBytes in the comparison', () => {
    expect(acpSource).toContain('new TextEncoder().encode(body.initialPrompt).length > maxPromptBytes');
  });

  it('error message interpolates the configurable limit', () => {
    expect(acpSource).toContain('`initialPrompt exceeds maximum size of ${maxPromptBytes} bytes`');
  });
});

// =============================================================================
// Source contract: MAX_ACP_CONTEXT_BYTES configurable (was 65536, now 262144)
// =============================================================================

describe('ACP sessions fork — configurable MAX_ACP_CONTEXT_BYTES', () => {
  const acpSource = readFileSync(
    resolve(process.cwd(), 'src/routes/projects/acp-sessions.ts'),
    'utf8'
  );

  it('reads context summary size limit from MAX_ACP_CONTEXT_BYTES env var', () => {
    expect(acpSource).toContain('c.env.MAX_ACP_CONTEXT_BYTES');
  });

  it('defaults to 262144 bytes (256 KB, relaxed from 64 KB)', () => {
    // The string '262144' appears for both prompt and context defaults
    const occurrences = (acpSource.match(/262144/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('uses configurable maxContextBytes in the comparison', () => {
    expect(acpSource).toContain('new TextEncoder().encode(body.contextSummary).length > maxContextBytes');
  });

  it('error message interpolates the configurable limit', () => {
    expect(acpSource).toContain('`contextSummary exceeds maximum size of ${maxContextBytes} bytes`');
  });
});

// =============================================================================
// Source contract: MCP route limits configurable
// =============================================================================

describe('MCP routes — configurable message length limits', () => {
  // After the mcp.ts → mcp/ directory split, the limits definition lives in _helpers.ts
  // and getMcpLimits() call sites are spread across handler files.
  const mcpDir = resolve(process.cwd(), 'src/routes/mcp');
  const mcpSource = readdirSync(mcpDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(resolve(mcpDir, f), 'utf8'))
    .join('\n');

  it('has a getMcpLimits() helper that reads from env', () => {
    expect(mcpSource).toContain('function getMcpLimits(env');
  });

  it('reads activity message length from MAX_ACTIVITY_MESSAGE_LENGTH env var', () => {
    expect(mcpSource).toContain('env.MAX_ACTIVITY_MESSAGE_LENGTH');
  });

  it('defaults activity message max length to 2000 (relaxed from 500)', () => {
    expect(mcpSource).toContain('DEFAULT_ACTIVITY_MESSAGE_MAX_LENGTH = 2000');
  });

  it('reads log message length from MAX_LOG_MESSAGE_LENGTH env var', () => {
    expect(mcpSource).toContain('env.MAX_LOG_MESSAGE_LENGTH');
  });

  it('defaults log message max length to 1000 (relaxed from 200)', () => {
    expect(mcpSource).toContain('DEFAULT_LOG_MESSAGE_MAX_LENGTH = 1000');
  });

  it('reads output summary length from MAX_OUTPUT_SUMMARY_LENGTH env var', () => {
    expect(mcpSource).toContain('env.MAX_OUTPUT_SUMMARY_LENGTH');
  });

  it('defaults output summary max length to 10000', () => {
    expect(mcpSource).toContain('DEFAULT_OUTPUT_SUMMARY_MAX_LENGTH = 10000');
  });

  it('uses getMcpLimits(env) at call sites (not module-level constants)', () => {
    // getMcpLimits(env) is called at each usage site so env is current per request
    const callCount = (mcpSource.match(/getMcpLimits\(env\)/g) || []).length;
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// Source contract: MAX_AGENT_SESSION_LABEL_LENGTH configurable
// =============================================================================

describe('agent sessions — configurable MAX_AGENT_SESSION_LABEL_LENGTH', () => {
  const agentSessionsSource = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/agent-sessions.ts'),
    'utf8'
  );

  it('reads label length limit from MAX_AGENT_SESSION_LABEL_LENGTH env var', () => {
    expect(agentSessionsSource).toContain('c.env.MAX_AGENT_SESSION_LABEL_LENGTH');
  });

  it('defaults label max length to 50 when env var is absent', () => {
    expect(agentSessionsSource).toContain('parsePositiveInt(c.env.MAX_AGENT_SESSION_LABEL_LENGTH, 50)');
  });

  it('uses configurable maxLabelLength in slice (not hardcoded 50)', () => {
    expect(agentSessionsSource).toContain('body.label?.trim()?.slice(0, maxLabelLength)');
  });
});

// =============================================================================
// Env interface — new configurable limit env vars are declared
// =============================================================================

describe('Env interface — new configurable limit env vars', () => {
  const indexSource = readFileSync(
    resolve(process.cwd(), 'src/index.ts'),
    'utf8'
  );

  it('declares MAX_TASK_MESSAGE_LENGTH in Env', () => {
    expect(indexSource).toContain('MAX_TASK_MESSAGE_LENGTH');
  });

  it('declares MAX_ACTIVITY_MESSAGE_LENGTH in Env', () => {
    expect(indexSource).toContain('MAX_ACTIVITY_MESSAGE_LENGTH');
  });

  it('declares MAX_LOG_MESSAGE_LENGTH in Env', () => {
    expect(indexSource).toContain('MAX_LOG_MESSAGE_LENGTH');
  });

  it('declares MAX_OUTPUT_SUMMARY_LENGTH in Env', () => {
    expect(indexSource).toContain('MAX_OUTPUT_SUMMARY_LENGTH');
  });

  it('declares MAX_ACP_PROMPT_BYTES in Env', () => {
    expect(indexSource).toContain('MAX_ACP_PROMPT_BYTES');
  });

  it('declares MAX_ACP_CONTEXT_BYTES in Env', () => {
    expect(indexSource).toContain('MAX_ACP_CONTEXT_BYTES');
  });

  it('declares MAX_MESSAGES_PER_BATCH in Env', () => {
    expect(indexSource).toContain('MAX_MESSAGES_PER_BATCH');
  });

  it('declares MAX_MESSAGES_PAYLOAD_BYTES in Env', () => {
    expect(indexSource).toContain('MAX_MESSAGES_PAYLOAD_BYTES');
  });

  it('declares MAX_AGENT_SESSION_LABEL_LENGTH in Env', () => {
    expect(indexSource).toContain('MAX_AGENT_SESSION_LABEL_LENGTH');
  });

  it('declares MAX_WORKSPACES_PER_NODE in Env', () => {
    expect(indexSource).toContain('MAX_WORKSPACES_PER_NODE');
  });
});

// =============================================================================
// Source contract: workspace create no longer enforces count limit
// =============================================================================

describe('workspace create — count limit removed', () => {
  const crudSource = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/crud.ts'),
    'utf8'
  );

  it('still counts active workspaces per node (for telemetry)', () => {
    expect(crudSource).toContain('nodeWorkspaceCount');
  });

  it('does not throw when workspace count is reached', () => {
    expect(crudSource).not.toContain('maxWorkspacesPerNode workspaces allowed per node');
    expect(crudSource).not.toContain('nodeWorkspaceCountVal >= limits.maxWorkspacesPerNode');
  });

  it('keeps the count query filtered to active statuses', () => {
    // Count query still filters by active statuses — just no longer used for enforcement
    expect(crudSource).toContain("inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])");
  });
});

// =============================================================================
// Source contract: task-runner DO enforces workspace count limit
// =============================================================================

describe('task-runner DO — workspace count limit', () => {
  const doSource = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
    'utf8'
  );

  it('references MAX_WORKSPACES_PER_NODE env var', () => {
    expect(doSource).toContain('MAX_WORKSPACES_PER_NODE');
  });

  it('references DEFAULT_MAX_WORKSPACES_PER_NODE constant', () => {
    expect(doSource).toContain('DEFAULT_MAX_WORKSPACES_PER_NODE');
  });

  it('still reads CPU and memory thresholds from env', () => {
    expect(doSource).toContain('TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
    expect(doSource).toContain('TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('queries workspace count per node for limit enforcement', () => {
    const section = doSource.slice(doSource.indexOf('findNodeWithCapacity'));
    expect(section).toContain('>= maxWorkspaces');
  });
});
