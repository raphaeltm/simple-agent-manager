/**
 * Behavioral tests for configurable system limits.
 *
 * Tests the actual exported functions and constants instead of
 * reading source code as strings. Covers ALL 15 configurable limits
 * with both default values and env var overrides.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RATE_LIMITS } from '../../../src/middleware/rate-limit';
import { getRuntimeLimits } from '../../../src/services/limits';

// =============================================================================
// getRuntimeLimits — behavioral tests for all 15 configurable limits
// =============================================================================

describe('getRuntimeLimits', () => {
  it('no longer returns maxWorkspacesPerNode', () => {
    const limits = getRuntimeLimits({});
    expect((limits as Record<string, unknown>).maxWorkspacesPerNode).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Default values for all 15 limits (no env overrides)
  // -------------------------------------------------------------------------

  describe('defaults (no env overrides)', () => {
    const defaults = getRuntimeLimits({});

    it('maxNodesPerUser defaults to 10', () => {
      expect(defaults.maxNodesPerUser).toBe(10);
    });

    it('maxAgentSessionsPerWorkspace defaults to 10', () => {
      expect(defaults.maxAgentSessionsPerWorkspace).toBe(10);
    });

    it('nodeHeartbeatStaleSeconds defaults to 180', () => {
      expect(defaults.nodeHeartbeatStaleSeconds).toBe(180);
    });

    it('maxProjectsPerUser defaults to 100', () => {
      expect(defaults.maxProjectsPerUser).toBe(100);
    });

    it('maxTasksPerProject defaults to 500', () => {
      expect(defaults.maxTasksPerProject).toBe(500);
    });

    it('maxTaskDependenciesPerTask defaults to 50', () => {
      expect(defaults.maxTaskDependenciesPerTask).toBe(50);
    });

    it('taskListDefaultPageSize defaults to 50', () => {
      expect(defaults.taskListDefaultPageSize).toBe(50);
    });

    it('taskListMaxPageSize defaults to 200', () => {
      expect(defaults.taskListMaxPageSize).toBe(200);
    });

    it('maxProjectRuntimeEnvVarsPerProject defaults to 150', () => {
      expect(defaults.maxProjectRuntimeEnvVarsPerProject).toBe(150);
    });

    it('maxProjectRuntimeFilesPerProject defaults to 50', () => {
      expect(defaults.maxProjectRuntimeFilesPerProject).toBe(50);
    });

    it('maxProjectRuntimeEnvValueBytes defaults to 8192', () => {
      expect(defaults.maxProjectRuntimeEnvValueBytes).toBe(8 * 1024);
    });

    it('maxProjectRuntimeFileContentBytes defaults to 131072', () => {
      expect(defaults.maxProjectRuntimeFileContentBytes).toBe(128 * 1024);
    });

    it('maxProjectRuntimeFilePathLength defaults to 256', () => {
      expect(defaults.maxProjectRuntimeFilePathLength).toBe(256);
    });

    it('taskCallbackTimeoutMs defaults to 10000', () => {
      expect(defaults.taskCallbackTimeoutMs).toBe(10000);
    });

    it('taskCallbackRetryMaxAttempts defaults to 3', () => {
      expect(defaults.taskCallbackRetryMaxAttempts).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Env var overrides for all 15 limits
  // -------------------------------------------------------------------------

  describe('env var overrides', () => {
    it('respects MAX_NODES_PER_USER', () => {
      expect(getRuntimeLimits({ MAX_NODES_PER_USER: '20' }).maxNodesPerUser).toBe(20);
    });

    it('respects MAX_AGENT_SESSIONS_PER_WORKSPACE', () => {
      expect(getRuntimeLimits({ MAX_AGENT_SESSIONS_PER_WORKSPACE: '5' }).maxAgentSessionsPerWorkspace).toBe(5);
    });

    it('respects NODE_HEARTBEAT_STALE_SECONDS', () => {
      expect(getRuntimeLimits({ NODE_HEARTBEAT_STALE_SECONDS: '300' }).nodeHeartbeatStaleSeconds).toBe(300);
    });

    it('respects MAX_PROJECTS_PER_USER', () => {
      expect(getRuntimeLimits({ MAX_PROJECTS_PER_USER: '200' }).maxProjectsPerUser).toBe(200);
    });

    it('respects MAX_TASKS_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_TASKS_PER_PROJECT: '1000' }).maxTasksPerProject).toBe(1000);
    });

    it('respects MAX_TASK_DEPENDENCIES_PER_TASK', () => {
      expect(getRuntimeLimits({ MAX_TASK_DEPENDENCIES_PER_TASK: '100' }).maxTaskDependenciesPerTask).toBe(100);
    });

    it('respects TASK_LIST_DEFAULT_PAGE_SIZE', () => {
      expect(getRuntimeLimits({ TASK_LIST_DEFAULT_PAGE_SIZE: '25' }).taskListDefaultPageSize).toBe(25);
    });

    it('respects TASK_LIST_MAX_PAGE_SIZE', () => {
      expect(getRuntimeLimits({ TASK_LIST_MAX_PAGE_SIZE: '500' }).taskListMaxPageSize).toBe(500);
    });

    it('respects MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_ENV_VARS_PER_PROJECT: '300' }).maxProjectRuntimeEnvVarsPerProject).toBe(300);
    });

    it('respects MAX_PROJECT_RUNTIME_FILES_PER_PROJECT', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILES_PER_PROJECT: '100' }).maxProjectRuntimeFilesPerProject).toBe(100);
    });

    it('respects MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_ENV_VALUE_BYTES: '16384' }).maxProjectRuntimeEnvValueBytes).toBe(16384);
    });

    it('respects MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILE_CONTENT_BYTES: '262144' }).maxProjectRuntimeFileContentBytes).toBe(262144);
    });

    it('respects MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH', () => {
      expect(getRuntimeLimits({ MAX_PROJECT_RUNTIME_FILE_PATH_LENGTH: '512' }).maxProjectRuntimeFilePathLength).toBe(512);
    });

    it('respects TASK_CALLBACK_TIMEOUT_MS', () => {
      expect(getRuntimeLimits({ TASK_CALLBACK_TIMEOUT_MS: '30000' }).taskCallbackTimeoutMs).toBe(30000);
    });

    it('respects TASK_CALLBACK_RETRY_MAX_ATTEMPTS', () => {
      expect(getRuntimeLimits({ TASK_CALLBACK_RETRY_MAX_ATTEMPTS: '5' }).taskCallbackRetryMaxAttempts).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid env values fall back to defaults
  // -------------------------------------------------------------------------

  describe('invalid env values use defaults', () => {
    it('ignores non-numeric string', () => {
      expect(getRuntimeLimits({ MAX_PROJECTS_PER_USER: 'not-a-number' }).maxProjectsPerUser).toBe(100);
    });

    it('ignores zero', () => {
      expect(getRuntimeLimits({ MAX_NODES_PER_USER: '0' }).maxNodesPerUser).toBe(10);
    });

    it('ignores negative numbers', () => {
      expect(getRuntimeLimits({ MAX_TASKS_PER_PROJECT: '-5' }).maxTasksPerProject).toBe(500);
    });

    it('ignores empty string', () => {
      expect(getRuntimeLimits({ NODE_HEARTBEAT_STALE_SECONDS: '' }).nodeHeartbeatStaleSeconds).toBe(180);
    });
  });
});

// =============================================================================
// DEFAULT_RATE_LIMITS — value assertions
// =============================================================================

describe('DEFAULT_RATE_LIMITS', () => {
  it('WORKSPACE_CREATE is 30', () => {
    expect(DEFAULT_RATE_LIMITS.WORKSPACE_CREATE).toBe(30);
  });

  it('CREDENTIAL_UPDATE is 30', () => {
    expect(DEFAULT_RATE_LIMITS.CREDENTIAL_UPDATE).toBe(30);
  });

  it('TERMINAL_TOKEN is 60', () => {
    expect(DEFAULT_RATE_LIMITS.TERMINAL_TOKEN).toBe(60);
  });

  it('ANONYMOUS is 100', () => {
    expect(DEFAULT_RATE_LIMITS.ANONYMOUS).toBe(100);
  });

  it('CLIENT_ERRORS is 200', () => {
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
  const doSource = [
    'index.ts',
    'types.ts',
    'node-steps.ts',
    'workspace-steps.ts',
    'agent-session-step.ts',
    'state-machine.ts',
    'helpers.ts',
  ].map(f => readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner', f), 'utf8')).join('\n');

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
