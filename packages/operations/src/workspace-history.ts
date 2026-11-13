/**
 * Workspace history reads shared by the workspace `sam-mcp` tools and the /sam agent tools:
 * archived tool-call payloads and workspace resource history.
 *
 * Each surface still owns its own authorization (workspace token project vs. project owner),
 * input parsing and error wording; these functions own the reads, the limits and the result.
 */
import { getPlatformOperationLimits } from './limits';
import type { OperationDeps } from './types';

export interface ArchivedToolPayloadRequest {
  projectId: string;
  messageId: string | null;
  sessionId: string | null;
  startTime: number | null;
  endTime: number | null;
  /** The caller's requested page size, or null for the configured default. */
  requestedLimit: number | null;
}

/**
 * Reads archived tool payloads for an already-authorized project. Returns `session_not_found`
 * when a `sessionId` is given that this project does not hold, so each surface can word it.
 */
export async function readArchivedToolPayloads(
  deps: OperationDeps,
  request: ArchivedToolPayloadRequest
): Promise<
  | {
      ok: true;
      result: Awaited<ReturnType<OperationDeps['ports']['projectData']['getArchivedToolPayloads']>>;
    }
  | { ok: false; reason: 'session_not_found' }
> {
  const { projectId, messageId, sessionId, startTime, endTime } = request;
  if (sessionId && !(await deps.ports.projectData.getSession(projectId, sessionId))) {
    return { ok: false, reason: 'session_not_found' };
  }
  const limits = getPlatformOperationLimits(deps.env);
  const limit = Math.min(
    Math.max(1, Math.round(request.requestedLimit ?? limits.archivedToolPayloadListLimit)),
    limits.archivedToolPayloadListMax
  );
  const result = await deps.ports.projectData.getArchivedToolPayloads(projectId, {
    ...(messageId ? { messageId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(startTime !== null ? { startTime } : {}),
    ...(endTime !== null ? { endTime } : {}),
    limit,
  });
  return { ok: true, result };
}

export interface ResourceHistoryScope {
  projectId: string;
  sessionId: string | null;
  taskId: string | null;
  workspaceId: string | null;
  chunkId: string | null;
}

/** Notes that tell an agent how to read resource history samples. */
const RESOURCE_HISTORY_NOTES = [
  'Samples are workspace-level cgroup observations, not per-process attribution.',
  'memoryWorkingSetMeanBytes and memoryWorkingSetPeakBytes estimate memory needed by excluding reclaimable inactive file cache; null means the VM agent did not report them.',
  'memoryMeanBytes, memoryPeakBytes, and memoryKernelPeakBytes include cache and remain available for historical comparison.',
  'Tool spans are timestamp correlation windows and may include an ACP kind and metadata-provided tool name; titles and inputs are never returned.',
  'Chunk detail is returned only when chunkId is supplied; summary reads stay bounded.',
];

/** Reads workspace resource history for an already-authorized, already-resolved scope. */
export async function readResourceHistory(deps: OperationDeps, scope: ResourceHistoryScope) {
  const { projectId, sessionId, taskId, workspaceId, chunkId } = scope;
  const history = await deps.ports.workspaces.resourceHistory({
    projectId,
    sessionId,
    taskId,
    workspaceId,
    detailChunkId: chunkId,
  });
  return {
    scope: { projectId, sessionId, taskId, workspaceId },
    ...history,
    notes: RESOURCE_HISTORY_NOTES,
  };
}
