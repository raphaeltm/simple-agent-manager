import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureManifest,
  ArchitectureRelationship,
  ArchitectureStateMachine,
  ArchitectureThread,
  ArchitectureView,
  SourceRef,
} from './schemas';

export interface SourceLocation {
  file: string;
  documentPath: string;
}

export interface Located<T> {
  value: T;
  location: SourceLocation;
}

export interface CompiledWorkspace {
  workspaceRoot: string;
  repoRoot: string;
  manifest: ArchitectureManifest;
  elements: ArchitectureElement[];
  relationships: ArchitectureRelationship[];
  flows: ArchitectureFlow[];
  stateMachines: ArchitectureStateMachine[];
  views: ArchitectureView[];
  threads: ArchitectureThread[];
  indexes: WorkspaceIndexes;
}

export interface WorkspaceIndexes {
  elementsById: Map<string, Located<ArchitectureElement>>;
  relationshipsById: Map<string, Located<ArchitectureRelationship>>;
  flowsById: Map<string, Located<ArchitectureFlow>>;
  stateMachinesById: Map<string, Located<ArchitectureStateMachine>>;
  viewsById: Map<string, Located<ArchitectureView>>;
  threadsById: Map<string, Located<ArchitectureThread>>;
  childrenByParent: Map<string, ArchitectureElement[]>;
  incomingByElement: Map<string, ArchitectureRelationship[]>;
  outgoingByElement: Map<string, ArchitectureRelationship[]>;
}

export interface LoadedWorkspace {
  workspace: CompiledWorkspace;
  diagnostics: import('./diagnostics').ArchitectureDiagnostic[];
}

export interface LoadWorkspaceOptions {
  workspaceRoot?: string;
  repoRoot?: string;
}

export interface SourceReadOptions {
  contextLines?: number;
  maxBytes?: number;
}

export interface SourceReadResult {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
}

export interface SourceBackedRecord {
  id: string;
  sourceRefs?: SourceRef[];
}
