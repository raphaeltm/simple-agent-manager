import type { SlashCommand } from '@simple-agent-manager/acp-client';
import type { AgentProfile } from '@simple-agent-manager/shared';

import type { SessionSourceContext } from '../../pages/project-chat/lineageUtils';

/** Props for the project chat session view. Split out of `SessionMessageView.tsx` (rule 18). */
export interface ProjectMessageViewProps {
  projectId: string;
  sessionId: string;
  /** When true, workspace is still provisioning — suppress "agent offline" banner. */
  isProvisioning?: boolean;
  /** Called after a mutation (e.g. mark complete) so the parent can refresh session list. */
  onSessionMutated?: () => void;
  /** Called when user clicks the retry button in the session header. */
  onRetry?: () => void;
  /** Called when user clicks the fork button in the session header. */
  onFork?: () => void;
  /** Source details for retries/forks. */
  sourceContext?: SessionSourceContext;
  /** Called when the user clicks Sleep on an awake idle conversation-mode session. */
  onSleepConversation?: () => void;
  /** Whether a sleep-conversation request is in flight. */
  sleepingConversation?: boolean;
  /** Error from a failed sleep-conversation attempt. */
  sleepError?: string | null;
  /** Called when the user confirms Archive on a sleeping conversation-mode session. */
  onCloseConversation?: () => void;
  /** Whether a close-conversation request is in flight. */
  closingConversation?: boolean;
  /** Error from a failed close-conversation attempt. */
  closeError?: string | null;
  /** Agent profiles available for @mention autocomplete in follow-up prompts. */
  agentProfiles?: AgentProfile[];
  /** Slash commands available for follow-up prompt autocomplete. */
  slashCommands?: SlashCommand[];
  /** Open hierarchy modal for the given task. */
  onShowHierarchy?: (taskId: string) => void;
  /** Start a new chat from read-only sessions. */
  onNewChat?: () => void;
  /** Message id requested by a route-level deep link, such as Project → Comments. */
  targetMessageId?: string | null;
  /** Timestamp used to load older history before resolving a route-level target. */
  targetMessageTimestamp?: number | null;
  /** Called once a route-level target has been consumed so refreshes do not re-jump. */
  onTargetMessageConsumed?: () => void;
  /** Changes whenever project realtime attention state changes for this session. */
  permissionRefreshSignal?: string | null;
  /** Comment thread to open, from a comment deep link (`?commentThread=`, see `useCommentDeepLink`). */
  focusCommentThreadId?: string | null;
}
