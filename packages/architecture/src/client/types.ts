import type { ElementDetails } from '../queries';
import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureRelationship,
  ArchitectureStateMachine,
  ArchitectureThread,
  SourceRef,
} from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { SourceReadResult } from '../types';

export type Lens = 'structure' | 'topology' | 'flow' | 'state';

export interface ViewerState {
  model?: ViewerModel;
  loading: boolean;
  error?: string;
  refreshError?: string;
  status: string;
  offline: boolean;
}

export interface Selection {
  kind: 'element' | 'flow' | 'stateMachine' | 'relationship';
  id: string;
}

export interface PreviewState {
  loading: boolean;
  error?: string;
  preview?: SourceReadResult;
}

export interface MutationState {
  saving: boolean;
  error?: string;
  artifactPath?: string;
  refreshWarning?: string;
}

export interface ApiClient {
  loadModel: () => Promise<ViewerModel>;
  loadElement: (id: string) => Promise<ElementDetails>;
  loadSource: (
    target: string,
    source: SourceRef,
    sourceIndex: number,
    options?: SourcePreviewOptions
  ) => Promise<SourceReadResult>;
  createThread: (input: ThreadInput) => Promise<ThreadMutationResult>;
  replyToThread: (threadId: string, input: ReplyInput) => Promise<ThreadMutationResult>;
  acceptThread: (threadId: string, input?: ThreadAcceptInput) => Promise<ThreadAcceptResult>;
}

export interface ThreadInput {
  target: string;
  question: string;
  author?: string;
}

export interface SourcePreviewOptions {
  fullFile?: boolean;
}

export interface ReplyInput {
  body: string;
  author?: string;
  replyTo?: string;
}

export interface ThreadAcceptInput {
  messageId?: string;
  author?: string;
}

export interface ThreadAcceptResult {
  accepted: {
    threadId: string;
    messageId: string;
    author: string;
    acceptedAt: string;
  };
}

export interface ThreadMutationResult {
  thread?: ArchitectureThread;
  message?: ArchitectureThread['messages'][number];
  artifactPath: string;
}

export interface StructureSlice {
  focus?: ArchitectureElement;
  breadcrumbs: ArchitectureElement[];
  omittedBreadcrumbs: number;
  children: ArchitectureElement[];
  relationships: ArchitectureRelationship[];
  omittedChildren: number;
  omittedRelationships: number;
}

export interface FlowSlice {
  flows: ArchitectureFlow[];
  omittedFlows: number;
  omittedSteps: number;
}

export interface StateSlice {
  machines: ArchitectureStateMachine[];
  omittedMachines: number;
  omittedStates: number;
  omittedTransitions: number;
}

export interface TopologySlice {
  elements: ArchitectureElement[];
  relationships: ArchitectureRelationship[];
  omittedElements: number;
  omittedRelationships: number;
}
