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

export type Lens = 'structure' | 'flow' | 'state';

export interface ViewerState {
  model?: ViewerModel;
  loading: boolean;
  error?: string;
  status: string;
  offline: boolean;
}

export interface Selection {
  kind: 'element' | 'flow' | 'stateMachine' | 'relationship' | 'thread';
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
}

export interface ApiClient {
  loadModel: () => Promise<ViewerModel>;
  loadElement: (id: string) => Promise<ElementDetails>;
  loadSource: (target: string, source: SourceRef, sourceIndex: number) => Promise<SourceReadResult>;
  createThread: (input: ThreadInput) => Promise<ThreadMutationResult>;
  replyToThread: (threadId: string, input: ReplyInput) => Promise<ThreadMutationResult>;
}

export interface ThreadInput {
  target: string;
  title: string;
  body: string;
  author?: string;
}

export interface ReplyInput {
  body: string;
  author?: string;
  replyTo?: string;
}

export interface ThreadMutationResult {
  thread?: ArchitectureThread;
  message?: ArchitectureThread['messages'][number];
  artifactPath: string;
}

export interface StructureSlice {
  focus?: ArchitectureElement;
  breadcrumbs: ArchitectureElement[];
  children: ArchitectureElement[];
  relationships: ArchitectureRelationship[];
}

export interface FlowSlice {
  flows: ArchitectureFlow[];
}

export interface StateSlice {
  machines: ArchitectureStateMachine[];
}
