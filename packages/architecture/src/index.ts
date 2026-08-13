export {
  ARCHITECTURE_SCHEMA_VERSION,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_QUERY_LIMITS,
  DEFAULT_SOURCE_CONTEXT_LINES,
  DEFAULT_THREAD_AUTHOR,
  DEFAULT_THREADS_DIR,
  DEFAULT_WORKSPACE_DIR,
} from './constants';
export type { ArchitectureDiagnostic, DiagnosticSeverity } from './diagnostics';
export { formatDiagnostics, hasErrors } from './diagnostics';
export type { BrokenSourceReference, ImpactedRecord, ImpactReport } from './impact';
export { mapChangedPathsToArchitecture } from './impact';
export { loadArchitectureWorkspace, validateArchitectureWorkspace } from './loader';
export { normalizeRepoRelativePath, PathSafetyError, resolveContainedPath } from './path-safety';
export type { ElementDetails, InboxItem, QueryLimits, WorkspaceSummary } from './queries';
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
export { readSourceReference } from './source';
export type { ReplyWriteOptions, ThreadWriteOptions } from './threads';
export {
  appendThreadReply,
  createThread,
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
