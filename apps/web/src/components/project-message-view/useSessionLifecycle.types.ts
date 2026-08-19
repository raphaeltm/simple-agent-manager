/**
 * Public result surface of `useSessionLifecycle`.
 *
 * Split out of the hook module to keep it under the 800-line hard ceiling
 * (rule 18). Types only — no runtime code, so consumers importing this pay
 * nothing at runtime.
 */

import type {
  NodeResponse,
  TaskExecutionStep,
  WorkspaceResponse,
} from '@simple-agent-manager/shared';

import type { ChatConnectionState } from '../../hooks/useChatWebSocket';
import type { useWorkspacePorts } from '../../hooks/useWorkspacePorts';
import type { ChatMessageResponse, ChatSessionResponse, SessionStateSnapshot } from '../../lib/api';
import type { FilePanelState } from './session-lifecycle-helpers';
import type { AgentActivityState, SessionState } from './types';

export interface UseSessionLifecycleResult {
  session: ChatSessionResponse | null;
  messages: ChatMessageResponse[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
  detectedPorts: ReturnType<typeof useWorkspacePorts>['ports'];
  followUp: string;
  setFollowUp: (v: string) => void;
  sendingFollowUp: boolean;
  uploading: boolean;
  isResuming: boolean;
  resumeStartedAt: number | null;
  resumeError: string | null;
  clearResumeError: () => void;
  connectionState: ChatConnectionState;
  showConnectionBanner: boolean;
  retryWs: () => void;
  agentActivity: AgentActivityState;
  /** True while a wake is in flight (hydrated from D1 or pushed over the socket). */
  isWaking: boolean;
  /** Current wake phase, or null before the replacement runner reports a step. */
  wakePhase: TaskExecutionStep | null;
  staleNotice: boolean;
  dismissStaleNotice: () => void;
  currentPlan: SessionStateSnapshot['currentPlan'];
  promptStartedAt: number | null;
  firstItemIndex: number;
  showScrollButton: boolean;
  setShowScrollButton: (v: boolean) => void;
  idleCountdownMs: number | null;
  filePanel: FilePanelState;
  setFilePanel: (v: FilePanelState) => void;
  handleFileClick: (path: string, line?: number | null) => void;
  handleOpenFileBrowser: () => void;
  handleOpenGitChanges: () => void;
  handleCancelPrompt: () => void;
  handleSendFollowUp: () => Promise<void>;
  handleUploadFiles: (files: FileList | File[]) => Promise<void>;
  loadMore: () => Promise<void>;
  loadUntil: (targetTimestamp: number) => Promise<void>;
  loadingMore: boolean;
  transcribeApiUrl: string;
  wsRef: React.RefObject<WebSocket | null>;
}
