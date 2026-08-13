export {
  ARCHITECTURE_SCHEMA_VERSION,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_QUERY_LIMITS,
  DEFAULT_SERVER_BODY_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_SOURCE_BYTES,
  DEFAULT_SERVER_SSE_CLIENT_LIMIT,
  DEFAULT_SERVER_STABLE_LOAD_ATTEMPTS,
  DEFAULT_SERVER_WATCH_INTERVAL_MS,
  DEFAULT_SOURCE_CONTEXT_LINES,
  DEFAULT_SOURCE_PATH_LIMIT,
  DEFAULT_THREAD_AUTHOR,
  DEFAULT_THREAD_AUTHOR_LIMIT,
  DEFAULT_THREAD_BODY_LIMIT,
  DEFAULT_THREAD_LOCK_RETRY_MS,
  DEFAULT_THREAD_LOCK_STALE_MS,
  DEFAULT_THREAD_LOCK_TIMEOUT_MS,
  DEFAULT_THREAD_TITLE_LIMIT,
  DEFAULT_THREADS_DIR,
  DEFAULT_VALIDATION_ISSUE_LIMIT,
  DEFAULT_VIEWER_CHILD_LIMIT,
  DEFAULT_VIEWER_FLOW_LIMIT,
  DEFAULT_VIEWER_FLOW_STEP_LIMIT,
  DEFAULT_VIEWER_MAX_ZOOM,
  DEFAULT_VIEWER_MIN_ZOOM,
  DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX,
  DEFAULT_VIEWER_PAN_PIXELS,
  DEFAULT_VIEWER_RELATIONSHIP_LIMIT,
  DEFAULT_VIEWER_STATE_LIMIT,
  DEFAULT_VIEWER_STATE_MACHINE_LIMIT,
  DEFAULT_VIEWER_TRANSITION_LIMIT,
  DEFAULT_VIEWER_ZOOM_STEP,
  DEFAULT_WORKSPACE_DIR,
} from './constants';
export type { ArchitectureDiagnostic, DiagnosticSeverity } from './diagnostics';
export { formatDiagnostics, hasErrors } from './diagnostics';
export type { BrokenSourceReference, ImpactedRecord, ImpactReport } from './impact';
export { mapChangedPathsToArchitecture } from './impact';
export { loadArchitectureWorkspace, validateArchitectureWorkspace } from './loader';
export { normalizeRepoRelativePath, PathSafetyError, resolveContainedPath } from './path-safety';
export type {
  BoundedFlow,
  BoundedStateMachine,
  BoundedThread,
  ElementDetails,
  InboxItem,
  QueryLimits,
  WorkspaceSummary,
} from './queries';
export {
  diagnosticsForQueries,
  getWorkspaceSummary,
  listUnresolvedInbox,
  showElement,
} from './queries';
export type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureManifest,
  ArchitectureRelationship,
  ArchitectureStateMachine,
  ArchitectureThread,
  ArchitectureView,
  ElementKind,
  FlowStep,
  SourceRef,
  StateDefinition,
  StateTransition,
  ThreadMessage,
  ThreadMessageMetadata,
  ThreadStatus,
} from './schemas';
export {
  elementKindSchema,
  elementSchema,
  flowSchema,
  flowStepSchema,
  manifestSchema,
  relationshipSchema,
  sourceRefSchema,
  stateMachineSchema,
  stateSchema,
  threadMessageMetadataSchema,
  threadMessageSchema,
  threadMetadataSchema,
  threadSchema,
  threadStatusSchema,
  transitionSchema,
  viewSchema,
  workspaceDocumentSchema,
} from './schemas';
export type { ArchitectureServerOptions, RunningArchitectureServer } from './server';
export { startArchitectureServer } from './server';
export type { ViewerInteraction, ViewerLimits, ViewerModel } from './server/payloads';
export { DEFAULT_VIEWER_INTERACTION, DEFAULT_VIEWER_LIMITS } from './server/payloads';
export { readSourceReference } from './source';
export type { ArchitectureTarget, ArchitectureTargetKind } from './targets';
export { hasArchitectureTarget, resolveArchitectureTarget } from './targets';
export type {
  ReplyWriteOptions,
  ThreadContentLimits,
  ThreadLockOptions,
  ThreadWriteOptions,
} from './threads';
export {
  appendThreadReply,
  createThread,
  DEFAULT_THREAD_CONTENT_LIMITS,
  DEFAULT_THREAD_LOCK_OPTIONS,
  loadThreads,
} from './threads';
export type {
  CompiledWorkspace,
  LoadedWorkspace,
  LoadWorkspaceOptions,
  Located,
  SourceBackedRecord,
  SourceLocation,
  SourceReadOptions,
  SourceReadResult,
  WorkspaceIndexes,
} from './types';
