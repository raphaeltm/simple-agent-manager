import type { SlashCommand } from '../types';
import type { AcpMessage } from './useAcpSession';

export interface UserMessage {
  kind: 'user_message';
  id: string;
  text: string;
  timestamp: number;
}

export interface AgentMessage {
  kind: 'agent_message';
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  text: string;
  active: boolean;
  timestamp: number;
}

export interface ToolCallItem {
  kind: 'tool_call';
  id: string;
  toolCallId: string;
  title: string;
  toolKind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content: ToolCallContentItem[];
  locations: Array<{ path: string; line?: number | null }>;
  timestamp: number;
  /** Byte size of stripped content (present when loaded in compact mode). */
  contentSize?: number;
  /** Whether content has been lazy-loaded (false = needs fetch on expand). */
  contentLoaded?: boolean;
  /** Message ID for lazy-loading content via the tool-content endpoint. */
  messageId?: string;
}

export interface ToolCallContentItem {
  type: 'content' | 'diff' | 'terminal';
  text?: string;
  data?: unknown;
}

export interface PlanItem {
  kind: 'plan';
  id: string;
  entries: Array<{
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  timestamp: number;
}

export interface SystemMessage {
  kind: 'system_message';
  id: string;
  text: string;
  timestamp: number;
}

export interface AgentCrashReportItem {
  kind: 'agent_crash_report';
  id: string;
  agentType: string;
  recovered: boolean;
  message: string;
  attribution: string;
  stderr?: string;
  stderrTruncated: boolean;
  suggestion: string;
  recoveryError?: string;
  timestamp: number;
}

export interface RawFallback {
  kind: 'raw_fallback';
  id: string;
  data: unknown;
  timestamp: number;
}

export type ConversationItem =
  | UserMessage
  | AgentMessage
  | SystemMessage
  | AgentCrashReportItem
  | ThinkingItem
  | ToolCallItem
  | PlanItem
  | RawFallback;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AcpMessagesHandle {
  items: ConversationItem[];
  usage: TokenUsage;
  availableCommands: SlashCommand[];
  processMessage: (msg: AcpMessage) => void;
  addUserMessage: (text: string) => void;
  clear: () => void;
  /**
   * Synchronously clear all items, finalize any streaming state, and reset
   * usage. Called by the session hook BEFORE replay messages arrive so replay
   * messages cannot append to stale state.
   */
  prepareForReplay: () => void;
}
