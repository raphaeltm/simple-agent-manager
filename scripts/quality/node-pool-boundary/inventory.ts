import {
  type AllocationTable,
  type AllocationWriter,
  scanAllocationWriters,
} from './allocation-writers';
import {
  type AllocationEntrypointCall,
  type AllocationEntrypointCallsite,
  scanAllocationEntrypoints,
} from './allocation-entrypoints';
import { describeEvidence, type EvidenceRequirement, hasEvidence } from './evidence';
import {
  type BoundaryViolation,
  enclosingFunctionBody,
  enclosingFunctionName,
  parseSourceFile,
  type SourceFileInput,
} from './source-files';

import ts from 'typescript';

export interface AllocationWriterInventoryEntry {
  filePath: string;
  table: AllocationTable;
  /** Enclosing function name; ownership is per callsite, not per file. */
  owner: string;
  role: string;
  canonicalService?: string;
  requiredEvidence?: EvidenceRequirement[];
}

/**
 * How a callsite is allowed to allocate. `unreviewed-bypass` is an honest
 * classification of current WIP application code, NOT an approval: it is
 * reported as a violation so the gate keeps failing until the callsite either
 * routes through shared admission or is deliberately re-classified.
 */
export type AllocationEntrypointStatus =
  | 'canonical'
  | 'role-adapter'
  | 'runtime-adapter'
  | 'runtime-dispatch'
  | 'unreviewed-bypass';

export interface AllocationEntrypointInventoryEntry {
  filePath: string;
  owner: string;
  entrypoint: AllocationEntrypointCall;
  /** Which control plane drives this callsite. */
  scope: 'task-runner' | 'route' | 'service' | 'trial-orchestrator';
  /** What the allocated capacity is for. */
  role: 'workspace' | 'deployment' | 'trial' | 'recovery-relay' | 'instant' | 'metering';
  /** The admission/authorization actually observed at this callsite. */
  admission: string;
  status: AllocationEntrypointStatus;
  requiredEvidence?: EvidenceRequirement[];
}

/**
 * The canonical task-start path is two module-level steps: resolve the placement
 * (through `resolveTaskStartPlacement` or one of its credential-attribution
 * variants) and hand the task to the TaskRunner DO. They legitimately sit in
 * sibling functions, so the evidence is module-scoped; per-callsite ownership is
 * enforced separately by the writer owner match.
 */
const CANONICAL_TASK_START: EvidenceRequirement[] = [
  {
    kind: 'anyCall',
    names: [
      'resolveTaskStartPlacement',
      'resolveTaskStartPlacementCredentialAttribution',
      'resolveTaskStartPlacementCredentialAttributionFromPlacement',
    ],
    scope: 'module',
  },
  {
    kind: 'anyCall',
    names: ['startTaskRunnerDO', 'ensureTaskRunnerStarted'],
    scope: 'module',
  },
];

export const ALLOCATION_WRITER_INVENTORY: readonly AllocationWriterInventoryEntry[] = [
  {
    filePath: 'apps/api/src/routes/tasks/submit.ts',
    table: 'tasks',
    owner: 'post /submit',
    role: 'user task submit route adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/routes/mcp/dispatch-tool.ts',
    table: 'tasks',
    owner: 'handleDispatchTask',
    role: 'MCP dispatch route adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/routes/mcp/orchestration-tools.ts',
    table: 'tasks',
    owner: 'handleRetrySubtask',
    role: 'MCP orchestration retry adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/services/trigger-submit.ts',
    table: 'tasks',
    owner: 'submitTriggeredTask',
    role: 'trigger submission adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts',
    table: 'tasks',
    owner: 'dispatchTask',
    role: 'SAM session dispatch tool adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts',
    table: 'tasks',
    owner: 'retrySubtask',
    role: 'SAM session subtask retry adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/services/session-recovery.ts',
    table: 'tasks',
    owner: 'createRecoveryTask',
    role: 'sleeping session wake recovery adapter',
    canonicalService: 'resolveTaskStartPlacement -> startTaskRunnerDO',
    requiredEvidence: CANONICAL_TASK_START,
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    table: 'tasks',
    owner: 'post /',
    role: 'legacy direct workspace conversation task adapter',
    canonicalService: 'explicit legacy workspace route adapter',
    requiredEvidence: [
      { kind: 'call', name: 'createNodeRecord' },
      { kind: 'call', name: 'provisionNode' },
    ],
  },
  {
    filePath: 'apps/api/src/routes/tasks/crud.ts',
    table: 'tasks',
    owner: 'post /',
    role: 'task metadata CRUD adapter',
    canonicalService: 'explicit non-running task creation adapter',
  },
  {
    filePath: 'apps/api/src/routes/chat.ts',
    table: 'tasks',
    owner: 'post /',
    role: 'conversation task compatibility adapter',
    canonicalService: 'explicit chat task adapter',
  },
  {
    filePath: 'apps/api/src/routes/chat-start.ts',
    table: 'tasks',
    owner: 'post /start',
    role: 'conversation start compatibility adapter',
    canonicalService: 'explicit chat-start task adapter',
  },
  {
    filePath: 'apps/api/src/routes/mcp/idea-tools.ts',
    table: 'tasks',
    owner: 'handleCreateIdea',
    role: 'MCP idea task materialization adapter',
    canonicalService: 'explicit idea adapter',
  },
  {
    filePath: 'apps/api/src/durable-objects/sam-session/tools/create-idea.ts',
    table: 'tasks',
    owner: 'createIdea',
    role: 'SAM session idea task materialization adapter',
    canonicalService: 'explicit idea adapter',
  },
  {
    filePath: 'apps/api/src/services/debug-agent.ts',
    table: 'tasks',
    owner: 'saveDebugDiagnosisAsIdea',
    role: 'debug diagnosis task adapter',
    canonicalService: 'explicit diagnostic adapter',
  },
  {
    filePath: 'apps/api/src/services/platform-feedback-triage/runner.ts',
    table: 'tasks',
    owner: 'runPlatformFeedbackTriage',
    role: 'platform feedback triage task adapter',
    canonicalService: 'explicit feedback adapter',
  },
  {
    filePath: 'apps/api/src/services/platform-feedback-incidents/user-report.ts',
    table: 'tasks',
    owner: 'upsertUserReportIncident',
    role: 'platform feedback incident task adapter',
    canonicalService: 'explicit feedback adapter',
  },
  {
    filePath: 'apps/api/src/services/trial/trial-runner.ts',
    table: 'tasks',
    owner: 'startDiscoveryAgent',
    role: 'trial orchestration task adapter',
    canonicalService: 'explicit trial runtime adapter',
  },
  {
    filePath: 'apps/api/src/services/session-task-repair.ts',
    table: 'tasks',
    owner: 'ensureSessionTaskBacked',
    role: 'session task repair adapter',
    canonicalService: 'explicit repair adapter',
  },
  {
    filePath: 'apps/api/src/services/nodes.ts',
    table: 'nodes',
    owner: 'createNodeRecord',
    role: 'canonical node row writer',
    canonicalService: 'createNodeRecord',
    requiredEvidence: [
      { kind: 'export', name: 'createNodeRecord' },
      { kind: 'call', name: 'capacityPlacementSnapshotDbValues' },
    ],
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    table: 'workspaces',
    owner: 'post /',
    role: 'legacy direct workspace route adapter',
    canonicalService: 'explicit legacy workspace route adapter',
    requiredEvidence: [{ kind: 'call', name: 'assertNodeAllocationPlanCurrent' }],
  },
  {
    filePath: 'apps/api/src/services/instant-session.ts',
    table: 'workspaces',
    owner: 'acceptInstantSession',
    role: 'Cloudflare container instant runtime adapter',
    canonicalService: 'explicit cf-container runtime adapter',
    requiredEvidence: [{ kind: 'property', name: 'runtime', value: 'cf-container' }],
  },
  {
    filePath: 'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    table: 'workspaces',
    owner: 'handleWorkspaceCreation',
    role: 'trial runtime workspace adapter',
    canonicalService: 'explicit trial runtime adapter',
    requiredEvidence: [{ kind: 'call', name: 'createWorkspaceOnNode' }],
  },
  {
    filePath: 'apps/api/src/services/workspace-placement.ts',
    table: 'workspaces',
    owner: 'reserveWorkspacePlacement',
    role: 'canonical final workspace placement writer',
    canonicalService: 'reserveWorkspacePlacement',
    requiredEvidence: [
      { kind: 'export', name: 'reserveWorkspacePlacement' },
      { kind: 'call', name: 'capacityPlacementSnapshotSqlValues' },
    ],
  },
  {
    filePath: 'apps/api/src/services/compute-usage.ts',
    table: 'compute_usage',
    owner: 'startComputeTracking',
    role: 'canonical compute metering row writer',
    canonicalService: 'startComputeTracking',
    requiredEvidence: [
      { kind: 'export', name: 'startComputeTracking' },
      { kind: 'property', name: 'providerInstanceVcpuCount' },
    ],
  },
] as const;

export const ALLOCATION_ENTRYPOINT_INVENTORY: readonly AllocationEntrypointInventoryEntry[] = [
  {
    filePath: 'apps/api/src/durable-objects/task-runner/node-steps.ts',
    owner: 'handleNodeProvisioning',
    entrypoint: 'createNodeRecord',
    scope: 'task-runner',
    role: 'workspace',
    admission:
      'recovery authority + VM provisioning admission lease revalidated at the allocation boundary',
    status: 'canonical',
    requiredEvidence: [
      { kind: 'call', name: 'assertVmProvisioningLease' },
      { kind: 'call', name: 'assertRecoveryAuthority' },
    ],
  },
  {
    filePath: 'apps/api/src/durable-objects/task-runner/node-steps.ts',
    owner: 'handleNodeProvisioning',
    entrypoint: 'provisionNode',
    scope: 'task-runner',
    role: 'workspace',
    admission: 'same lease-guarded provisioning loop as the node record it provisions',
    status: 'canonical',
    requiredEvidence: [{ kind: 'call', name: 'assertVmProvisioningLease' }],
  },
  {
    filePath: 'apps/api/src/durable-objects/task-runner/workspace-steps.ts',
    owner: 'createAndProvisionWorkspace',
    entrypoint: 'reserveWorkspacePlacement',
    scope: 'task-runner',
    role: 'workspace',
    admission: 'canonical atomic placement reservation',
    status: 'canonical',
  },
  {
    filePath: 'apps/api/src/durable-objects/task-runner/workspace-steps.ts',
    owner: 'createWorkspaceOnVmAgent',
    entrypoint: 'createWorkspaceOnNode',
    scope: 'task-runner',
    role: 'workspace',
    admission: 'runtime creation for an already reserved placement',
    status: 'runtime-dispatch',
  },
  {
    filePath: 'apps/api/src/durable-objects/task-runner/workspace-steps.ts',
    owner: 'startComputeTrackingBestEffort',
    entrypoint: 'startComputeTracking',
    scope: 'task-runner',
    role: 'metering',
    admission: 'metering for an already reserved placement',
    status: 'canonical',
  },
  {
    filePath: 'apps/api/src/routes/nodes.ts',
    owner: 'post /',
    entrypoint: 'createNodeRecord',
    scope: 'route',
    role: 'workspace',
    admission:
      'cloud credential resolution + monthly compute quota only; writes a null capacity snapshot, so no pool membership, revision or aggregate admission is checked',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/routes/nodes.ts',
    owner: 'post /',
    entrypoint: 'provisionNode',
    scope: 'route',
    role: 'workspace',
    admission: 'paid provisioning of the unpooled node created above; no admission lease',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    owner: 'post /',
    entrypoint: 'createNodeRecord',
    scope: 'route',
    role: 'workspace',
    admission:
      'per-user node count cap + credential resolution; explicit-node reuse revalidates the allocation plan, but the provisioning branch takes no capacity-pool selection or admission lease',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    owner: 'post /',
    entrypoint: 'provisionNode',
    scope: 'route',
    role: 'workspace',
    admission: 'paid provisioning of the node created above; no admission lease',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/routes/workspaces/crud.ts',
    owner: 'startComputeTrackingForNode',
    entrypoint: 'startComputeTracking',
    scope: 'route',
    role: 'metering',
    admission: 'metering for the legacy direct workspace route',
    status: 'runtime-dispatch',
  },
  {
    filePath: 'apps/api/src/routes/workspaces/_helpers.ts',
    owner: 'scheduleWorkspaceCreateOnNode',
    entrypoint: 'createWorkspaceOnNode',
    scope: 'route',
    role: 'workspace',
    admission: 'runtime creation for a workspace row the route already reserved',
    status: 'runtime-dispatch',
  },
  {
    filePath: 'apps/api/src/routes/node-lifecycle.ts',
    owner: 'post /:id/ready',
    entrypoint: 'createWorkspaceOnNode',
    scope: 'route',
    role: 'workspace',
    admission:
      're-dispatch of already reserved `creating`/undispatched workspaces on a node that just reported ready; allocates no new capacity',
    status: 'runtime-dispatch',
  },
  {
    filePath: 'apps/api/src/services/deployment-provisioning.ts',
    owner: 'provisionDeploymentNode',
    entrypoint: 'createNodeRecord',
    scope: 'service',
    role: 'deployment',
    admission:
      'explicit deployment role adapter with its own concurrent-placement guard; does not take the shared VM provisioning admission lease',
    status: 'role-adapter',
    requiredEvidence: [{ kind: 'property', name: 'nodeRole', value: 'deployment' }],
  },
  {
    filePath: 'apps/api/src/services/deployment-provisioning.ts',
    owner: 'provisionDeploymentNode',
    entrypoint: 'provisionNode',
    scope: 'service',
    role: 'deployment',
    admission: 'paid provisioning of the deployment-role node created above',
    status: 'role-adapter',
  },
  {
    filePath: 'apps/api/src/services/session-snapshot-upload-relay.ts',
    owner: 'ensureSessionSnapshotUploadRelay',
    entrypoint: 'createNodeRecord',
    scope: 'service',
    role: 'recovery-relay',
    admission:
      'credential resolution + monthly compute quota only; copies the source node capacity snapshot without revalidating pool revision, membership or aggregate capacity',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/services/session-snapshot-upload-relay.ts',
    owner: 'ensureSessionSnapshotUploadRelay',
    entrypoint: 'provisionNode',
    scope: 'service',
    role: 'recovery-relay',
    admission: 'paid provisioning of the relay node created above; no admission lease',
    status: 'unreviewed-bypass',
  },
  {
    filePath: 'apps/api/src/services/instant-session.ts',
    owner: 'acceptInstantSession',
    entrypoint: 'createNodeRecord',
    scope: 'service',
    role: 'instant',
    admission:
      'Cloudflare container runtime record; allocates no VM capacity, so the VM admission lease does not apply',
    status: 'runtime-adapter',
    requiredEvidence: [{ kind: 'property', name: 'runtime', value: 'cf-container' }],
  },
  {
    filePath: 'apps/api/src/services/instant-session.ts',
    owner: 'continueInstantSessionLaunch',
    entrypoint: 'createWorkspaceOnNode',
    scope: 'service',
    role: 'instant',
    admission: 'runtime creation for an already accepted instant session',
    status: 'runtime-dispatch',
  },
  {
    filePath: 'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    owner: 'handleNodeProvisioning',
    entrypoint: 'createNodeRecord',
    scope: 'trial-orchestrator',
    role: 'trial',
    admission:
      'single-node-per-trial state guard on the platform credential; no capacity-pool selection or admission lease',
    status: 'runtime-adapter',
  },
  {
    filePath: 'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    owner: 'handleNodeProvisioning',
    entrypoint: 'provisionNode',
    scope: 'trial-orchestrator',
    role: 'trial',
    admission: 'paid provisioning of the trial node created above',
    status: 'runtime-adapter',
  },
  {
    filePath: 'apps/api/src/durable-objects/trial-orchestrator/steps.ts',
    owner: 'handleWorkspaceCreation',
    entrypoint: 'createWorkspaceOnNode',
    scope: 'trial-orchestrator',
    role: 'trial',
    admission: 'runtime creation for the trial workspace row reserved in the same step',
    status: 'runtime-dispatch',
  },
] as const;

export function validateAllocationWriterInventory(
  files: readonly SourceFileInput[],
  inventory: readonly AllocationWriterInventoryEntry[] = ALLOCATION_WRITER_INVENTORY
): BoundaryViolation[] {
  const writers = scanAllocationWriters(files);
  const violations: BoundaryViolation[] = [];

  for (const writer of writers) {
    const entry = inventory.find(
      (candidate) =>
        candidate.filePath === writer.filePath &&
        candidate.table === writer.table &&
        candidate.owner === writer.owner
    );
    if (entry) continue;
    const fileIsInventoried = inventory.some(
      (candidate) => candidate.filePath === writer.filePath && candidate.table === writer.table
    );
    violations.push({
      kind: 'allocation-writer',
      filePath: writer.filePath,
      line: writer.line,
      column: writer.column,
      reason: fileIsInventoried
        ? `unowned ${writer.table} ${writer.writerKind} in "${writer.owner}"; the inventory owns a different function in this file, so this writer bypasses the reviewed one`
        : `unexpected ${writer.table} ${writer.writerKind} in "${writer.owner}"; add a narrow inventory role or route through a canonical service`,
      snippet: writer.snippet,
    });
  }

  for (const entry of inventory) {
    const writer = writers.find(
      (candidate) =>
        candidate.filePath === entry.filePath &&
        candidate.table === entry.table &&
        candidate.owner === entry.owner
    );
    if (!writer) {
      violations.push({
        kind: 'allocation-writer',
        filePath: entry.filePath,
        line: 1,
        column: 1,
        reason: `inventory entry for ${entry.table} writer "${entry.owner}" is missing from source`,
        snippet: entry.role,
      });
      continue;
    }
    violations.push(
      ...missingEvidenceViolations(files, entry.requiredEvidence, writer, (evidence) =>
        `${entry.table} writer role "${entry.role}" is missing required evidence in "${entry.owner}": ${evidence}`
      )
    );
  }

  return violations;
}

export function validateAllocationEntrypointInventory(
  files: readonly SourceFileInput[],
  inventory: readonly AllocationEntrypointInventoryEntry[] = ALLOCATION_ENTRYPOINT_INVENTORY
): BoundaryViolation[] {
  const callsites = scanAllocationEntrypoints(files);
  const violations: BoundaryViolation[] = [];

  for (const callsite of callsites) {
    const entry = inventory.find(
      (candidate) =>
        candidate.filePath === callsite.filePath &&
        candidate.owner === callsite.owner &&
        candidate.entrypoint === callsite.entrypoint
    );
    if (!entry) {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: callsite.filePath,
        line: callsite.line,
        column: callsite.column,
        reason: `uninventoried allocation entrypoint ${callsite.entrypoint}() in "${callsite.owner}"; declare its scope, role and admission contract`,
        snippet: callsite.snippet,
      });
      continue;
    }
    if (entry.status === 'unreviewed-bypass') {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: callsite.filePath,
        line: callsite.line,
        column: callsite.column,
        reason: `${callsite.entrypoint}() in "${callsite.owner}" bypasses shared node-pool admission: ${entry.admission}`,
        snippet: callsite.snippet,
      });
    }
    violations.push(
      ...missingEvidenceViolations(files, entry.requiredEvidence, callsite, (evidence) =>
        `${callsite.entrypoint}() in "${callsite.owner}" is missing required evidence: ${evidence}`
      )
    );
  }

  for (const entry of inventory) {
    const callsite = callsites.find(
      (candidate) =>
        candidate.filePath === entry.filePath &&
        candidate.owner === entry.owner &&
        candidate.entrypoint === entry.entrypoint
    );
    if (!callsite) {
      violations.push({
        kind: 'allocation-entrypoint',
        filePath: entry.filePath,
        line: 1,
        column: 1,
        reason: `inventory entry for allocation entrypoint ${entry.entrypoint}() in "${entry.owner}" is missing from source`,
        snippet: entry.admission,
      });
    }
  }

  return violations;
}

function missingEvidenceViolations(
  files: readonly SourceFileInput[],
  required: readonly EvidenceRequirement[] | undefined,
  site: { filePath: string; line: number; column: number; snippet: string },
  reason: (evidence: string) => string
): BoundaryViolation[] {
  if (!required || required.length === 0) return [];
  const file = files.find((candidate) => candidate.filePath === site.filePath);
  if (!file) return [];
  const sourceFile = parseSourceFile(file);
  const scope = ownerScope(sourceFile, site.line, site.column);
  return required
    .filter((requirement) => !hasEvidence(sourceFile, scope, requirement))
    .map((requirement) => ({
      kind: 'allocation-writer' as const,
      filePath: site.filePath,
      line: site.line,
      column: site.column,
      reason: reason(describeEvidence(requirement)),
      snippet: site.snippet,
    }));
}

/** The function body containing the recorded writer/entrypoint position. */
function ownerScope(sourceFile: ts.SourceFile, line: number, column: number): ts.Node | null {
  const position = sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
  let scope: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) <= position && position < node.getEnd()) {
      const body = enclosingFunctionBody(node);
      if (body && enclosingFunctionName(node) !== '<module>') scope = body;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return scope;
}
