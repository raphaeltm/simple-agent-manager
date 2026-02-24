import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('task-runs routes source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/routes/task-runs.ts'), 'utf8');

  it('defines the autonomous run endpoint', () => {
    expect(file).toContain("taskRunsRoutes.post('/:taskId/run',");
  });

  it('defines the cleanup endpoint', () => {
    expect(file).toContain("taskRunsRoutes.post('/:taskId/run/cleanup',");
  });

  it('requires authentication for all endpoints', () => {
    expect(file).toContain('requireAuth()');
  });

  it('validates task ownership before running', () => {
    expect(file).toContain('requireOwnedProject');
    expect(file).toContain('requireOwnedTask');
  });

  it('checks task status is ready before initiating run', () => {
    expect(file).toContain("task.status !== 'ready'");
    expect(file).toContain("must be in 'ready' status to run autonomously");
  });

  it('checks for blocked dependencies before running', () => {
    expect(file).toContain('isTaskBlocked');
    expect(file).toContain('Task is blocked by unresolved dependencies');
    expect(file).toContain('taskDependencies');
  });

  it('requires Hetzner credentials for node provisioning', () => {
    expect(file).toContain("eq(schema.credentials.provider, 'hetzner')");
    expect(file).toContain('Hetzner credentials required');
  });

  it('validates vmSize parameter', () => {
    expect(file).toContain("['small', 'medium', 'large']");
    expect(file).toContain('vmSize must be small, medium, or large');
  });

  it('validates vmLocation parameter', () => {
    expect(file).toContain("['nbg1', 'fsn1', 'hel1']");
    expect(file).toContain('vmLocation must be nbg1, fsn1, or hel1');
  });

  it('calls initiateTaskRun with correct parameters', () => {
    expect(file).toContain('initiateTaskRun');
    expect(file).toContain('taskId: task.id');
    expect(file).toContain('projectId');
    expect(file).toContain('vmSize: body.vmSize');
    expect(file).toContain('vmLocation: body.vmLocation');
    expect(file).toContain('nodeId: body.nodeId');
    expect(file).toContain('branch: body.branch');
    expect(file).toContain('userName: auth.user.name');
    expect(file).toContain('userEmail: auth.user.email');
  });

  it('returns 202 Accepted for successful run initiation', () => {
    expect(file).toContain('c.json(response, 202)');
  });

  it('uses waitUntil for async execution', () => {
    expect(file).toContain('c.executionCtx.waitUntil');
  });

  it('handles TaskRunError codes with appropriate HTTP status codes', () => {
    expect(file).toContain('TaskRunError');
    expect(file).toContain("case 'NOT_FOUND':");
    expect(file).toContain("case 'INVALID_STATUS':");
    expect(file).toContain("case 'NODE_UNAVAILABLE':");
    expect(file).toContain("case 'LIMIT_EXCEEDED':");
    expect(file).toContain('errors.notFound');
    expect(file).toContain('errors.conflict');
    expect(file).toContain('errors.badRequest');
    expect(file).toContain('errors.internal');
  });

  it('returns RunTaskResponse shape', () => {
    expect(file).toContain('taskId: result.taskId');
    expect(file).toContain('status: result.status');
    expect(file).toContain('workspaceId: result.workspaceId');
    expect(file).toContain('nodeId: result.nodeId');
    expect(file).toContain('autoProvisionedNode: result.autoProvisionedNode');
  });

  it('validates terminal states for cleanup', () => {
    expect(file).toContain("task.status !== 'completed'");
    expect(file).toContain("task.status !== 'failed'");
    expect(file).toContain("task.status !== 'cancelled'");
    expect(file).toContain('completed, failed, or cancelled status for cleanup');
  });

  it('calls cleanupTaskRun for cleanup endpoint', () => {
    expect(file).toContain('cleanupTaskRun(task.id, c.env)');
  });
});

describe('task-runs service source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/services/task-runner.ts'), 'utf8');

  it('exports initiateTaskRun function', () => {
    expect(file).toContain('export async function initiateTaskRun');
  });

  it('exports cleanupTaskRun function', () => {
    expect(file).toContain('export async function cleanupTaskRun');
  });

  it('exports TaskRunError class', () => {
    expect(file).toContain('export class TaskRunError');
  });

  it('transitions task through correct status sequence', () => {
    // queued → delegated → in_progress (normal flow)
    expect(file).toContain("status: 'queued'");
    expect(file).toContain("toStatus: 'queued'");
    expect(file).toContain("status: 'delegated'");
    expect(file).toContain("toStatus: 'delegated'");
    expect(file).toContain("status: 'in_progress'");
    expect(file).toContain("toStatus: 'in_progress'");
  });

  it('handles failure with proper status transition', () => {
    expect(file).toContain("status: 'failed'");
    expect(file).toContain("toStatus: 'failed'");
    expect(file).toContain('failTask');
  });

  it('records task status events for audit trail', () => {
    expect(file).toContain('taskStatusEvents');
    expect(file).toContain("actorType: 'system'");
  });

  it('selects or creates nodes for task execution', () => {
    expect(file).toContain('selectNodeForTaskRun');
    expect(file).toContain('createNodeRecord');
    expect(file).toContain('provisionNode');
    expect(file).toContain('waitForNodeAgentReady');
  });

  it('creates workspace with proper configuration', () => {
    expect(file).toContain('createWorkspaceOnNode');
    expect(file).toContain('signCallbackToken');
    expect(file).toContain('resolveUniqueWorkspaceDisplayName');
  });

  it('creates agent session for task execution', () => {
    expect(file).toContain('createAgentSessionOnNode');
    expect(file).toContain("status: 'running'");
  });

  it('tracks auto-provisioned nodes for cleanup', () => {
    expect(file).toContain('autoProvisionedNodeId');
    expect(file).toContain('autoProvisioned');
  });

  it('implements workspace readiness polling', () => {
    expect(file).toContain('waitForWorkspaceReady');
    expect(file).toContain('WORKSPACE_READY_TIMEOUT_MS');
  });

  it('implements best-effort cleanup on failure', () => {
    expect(file).toContain('stopWorkspaceOnNode');
    expect(file).toContain('cleanupAutoProvisionedNode');
    // Best-effort pattern: try/catch around cleanup
    expect(file).toContain('// Best effort');
  });

  it('checks node limits before auto-provisioning', () => {
    expect(file).toContain('maxNodesPerUser');
    expect(file).toContain('Cannot auto-provision');
  });

  it('uses configurable cleanup delay', () => {
    expect(file).toContain('TASK_RUN_CLEANUP_DELAY_MS');
    expect(file).toContain('getCleanupDelayMs');
  });
});

describe('node-selector service source contract', () => {
  const file = readFileSync(resolve(process.cwd(), 'src/services/node-selector.ts'), 'utf8');

  it('exports selectNodeForTaskRun function', () => {
    expect(file).toContain('export async function selectNodeForTaskRun');
  });

  it('exports scoreNodeLoad function', () => {
    expect(file).toContain('export function scoreNodeLoad');
  });

  it('exports nodeHasCapacity function', () => {
    expect(file).toContain('export function nodeHasCapacity');
  });

  it('queries running nodes for the user', () => {
    expect(file).toContain("eq(schema.nodes.status, 'running')");
    expect(file).toContain('eq(schema.nodes.userId, userId)');
  });

  it('filters out unhealthy nodes', () => {
    expect(file).toContain("node.healthStatus === 'unhealthy'");
  });

  it('counts active workspaces per node', () => {
    expect(file).toContain('eq(schema.workspaces.nodeId, node.id)');
    expect(file).toContain('count()');
  });

  it('uses configurable CPU and memory thresholds', () => {
    expect(file).toContain('TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
    expect(file).toContain('TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('sorts candidates by location preference then load', () => {
    expect(file).toContain('preferredLocation');
    expect(file).toContain('preferredSize');
    expect(file).toContain('scoreNodeLoad');
    expect(file).toContain('candidates.sort');
  });

  it('parses node metrics from JSON', () => {
    expect(file).toContain('parseMetrics');
    expect(file).toContain('JSON.parse');
    expect(file).toContain('lastMetrics');
  });
});

describe('schema migration source contract', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'src/db/migrations/0013_task_auto_provisioned_node.sql'),
    'utf8'
  );

  it('adds autoProvisionedNodeId column to tasks table', () => {
    expect(migration).toContain('ALTER TABLE tasks ADD COLUMN auto_provisioned_node_id');
  });

  it('references nodes table with foreign key', () => {
    expect(migration).toContain('REFERENCES nodes(id)');
  });

  it('sets null on node deletion', () => {
    expect(migration).toContain('ON DELETE SET NULL');
  });

  it('creates conditional index for non-null values', () => {
    expect(migration).toContain('CREATE INDEX idx_tasks_auto_provisioned_node');
    expect(migration).toContain('WHERE auto_provisioned_node_id IS NOT NULL');
  });
});

describe('schema source contract', () => {
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');

  it('defines autoProvisionedNodeId column on tasks table', () => {
    expect(schemaFile).toContain("autoProvisionedNodeId: text('auto_provisioned_node_id')");
  });

  it('references nodes table from autoProvisionedNodeId', () => {
    expect(schemaFile).toContain('.references(() => nodes.id,');
  });
});

describe('shared types source contract', () => {
  const typesFile = readFileSync(
    resolve(process.cwd(), '../../packages/shared/src/types.ts'),
    'utf8'
  );

  it('defines RunTaskRequest interface', () => {
    expect(typesFile).toContain('export interface RunTaskRequest');
    expect(typesFile).toContain('vmSize?: VMSize');
    expect(typesFile).toContain('vmLocation?: VMLocation');
    expect(typesFile).toContain('nodeId?: string');
    expect(typesFile).toContain('branch?: string');
  });

  it('defines RunTaskResponse interface', () => {
    expect(typesFile).toContain('export interface RunTaskResponse');
    expect(typesFile).toContain('taskId: string');
    expect(typesFile).toContain('status: TaskStatus');
    expect(typesFile).toContain('workspaceId: string | null');
    expect(typesFile).toContain('nodeId: string | null');
    expect(typesFile).toContain('autoProvisionedNode: boolean');
  });
});

describe('shared constants source contract', () => {
  const constantsFile = readFileSync(
    resolve(process.cwd(), '../../packages/shared/src/constants.ts'),
    'utf8'
  );

  it('defines task run threshold constants', () => {
    expect(constantsFile).toContain('DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
    expect(constantsFile).toContain('DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
  });

  it('defines task run timeout constants', () => {
    expect(constantsFile).toContain('DEFAULT_TASK_RUN_CLEANUP_DELAY_MS');
  });

  it('sets reasonable defaults for thresholds', () => {
    expect(constantsFile).toContain('DEFAULT_TASK_RUN_NODE_CPU_THRESHOLD_PERCENT = 80');
    expect(constantsFile).toContain('DEFAULT_TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT = 80');
  });
});

describe('API index route registration', () => {
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  it('imports taskRunsRoutes', () => {
    expect(indexFile).toContain("import { taskRunsRoutes } from './routes/task-runs'");
  });

  it('registers task runs route under project tasks prefix', () => {
    expect(indexFile).toContain(
      "app.route('/api/projects/:projectId/tasks', taskRunsRoutes)"
    );
  });

  it('defines task run configuration env vars', () => {
    expect(indexFile).toContain('TASK_RUN_NODE_CPU_THRESHOLD_PERCENT');
    expect(indexFile).toContain('TASK_RUN_NODE_MEMORY_THRESHOLD_PERCENT');
    expect(indexFile).toContain('TASK_RUN_CLEANUP_DELAY_MS');
    expect(indexFile).toContain('WORKSPACE_READY_TIMEOUT_MS');
  });
});
