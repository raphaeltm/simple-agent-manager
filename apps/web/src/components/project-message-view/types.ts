import type { ConversationItem } from '@simple-agent-manager/acp-client';
import { mapToolCallContent } from '@simple-agent-manager/acp-client';

import type { ChatMessageResponse, ChatSessionResponse } from '../../lib/api';

/** Default idle timeout in ms — matches the server-side default (NODE_WARM_TIMEOUT_MS). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Grace period (ms) after agent stops prompting before switching from full ACP
 * view to merged DO+ACP view. Matches ~2s VM agent batch delay + 1s buffer.
 * Configurable via VITE_ACP_GRACE_MS environment variable.
 */
const DEFAULT_ACP_GRACE_MS = 3_000;
export const ACP_GRACE_MS = parseInt(import.meta.env.VITE_ACP_GRACE_MS || String(DEFAULT_ACP_GRACE_MS), 10);

/**
 * Delay (ms) before the auto-resume effect calls the resume API. Gives the
 * ACP WebSocket's own visibility-change reconnection a chance to succeed first.
 * Configurable via VITE_AUTO_RESUME_DELAY_MS environment variable.
 */
const DEFAULT_AUTO_RESUME_DELAY_MS = 2_000;
export const AUTO_RESUME_DELAY_MS = parseInt(import.meta.env.VITE_AUTO_RESUME_DELAY_MS || String(DEFAULT_AUTO_RESUME_DELAY_MS), 10);

/**
 * Delay (ms) before the ACP recovery effect kicks in after the ACP WebSocket
 * enters error state while the session is still active. This gives the ACP
 * hook's own reconnection a chance to succeed before we intervene.
 * Configurable via VITE_ACP_RECOVERY_DELAY_MS environment variable.
 */
const DEFAULT_ACP_RECOVERY_DELAY_MS = 5_000;
export const ACP_RECOVERY_DELAY_MS = parseInt(import.meta.env.VITE_ACP_RECOVERY_DELAY_MS || String(DEFAULT_ACP_RECOVERY_DELAY_MS), 10);

/**
 * Interval (ms) between ACP recovery retry attempts after the first recovery
 * attempt fails. Each attempt calls resumeAgentSession + reconnect.
 * Configurable via VITE_ACP_RECOVERY_INTERVAL_MS environment variable.
 */
const DEFAULT_ACP_RECOVERY_INTERVAL_MS = 30_000;
export const ACP_RECOVERY_INTERVAL_MS = parseInt(import.meta.env.VITE_ACP_RECOVERY_INTERVAL_MS || String(DEFAULT_ACP_RECOVERY_INTERVAL_MS), 10);

/**
 * Maximum number of ACP recovery attempts before giving up. After this many
 * failures, the user sees the error banner with a manual Reconnect button.
 * Configurable via VITE_ACP_RECOVERY_MAX_ATTEMPTS environment variable.
 */
const DEFAULT_ACP_RECOVERY_MAX_ATTEMPTS = 10;
export const ACP_RECOVERY_MAX_ATTEMPTS = parseInt(import.meta.env.VITE_ACP_RECOVERY_MAX_ATTEMPTS || String(DEFAULT_ACP_RECOVERY_MAX_ATTEMPTS), 10);

/**
 * Debounce delay (ms) before showing the "Reconnecting..." banner for the DO
 * WebSocket. Brief blips that self-heal within this window are invisible.
 * Configurable via VITE_RECONNECT_BANNER_DELAY_MS environment variable.
 */
const DEFAULT_RECONNECT_BANNER_DELAY_MS = 3_000;
export const RECONNECT_BANNER_DELAY_MS = parseInt(import.meta.env.VITE_RECONNECT_BANNER_DELAY_MS || String(DEFAULT_RECONNECT_BANNER_DELAY_MS), 10);

/** Virtual scroll: starting index for prepend-stable pagination */
export const VIRTUAL_START = 100_000;

/** True for placeholder content that adds no user value. */
function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '(tool call)' || trimmed === '(tool update)';
}

// ---------------------------------------------------------------------------
// Message grouping — merges consecutive same-role messages for clean display
// ---------------------------------------------------------------------------

interface MessageGroup {
  id: string;          // ID of first message in group
  role: string;
  messages: ChatMessageResponse[];
  createdAt: number;   // Timestamp of first message
}

/** Groups consecutive messages by role. Assistant chunks become one bubble,
 *  consecutive tool messages become one activity block. */
export function groupMessages(msgs: ChatMessageResponse[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const msg of msgs) {
    const last = groups[groups.length - 1];
    // Merge into existing group if same role and both are groupable roles
    if (last && last.role === msg.role && (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'thinking')) {
      last.messages.push(msg);
    } else {
      groups.push({
        id: msg.id,
        role: msg.role,
        messages: [msg],
        createdAt: msg.createdAt,
      });
    }
  }
  return groups;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Session state derivation
// ---------------------------------------------------------------------------

export type SessionState = 'active' | 'idle' | 'terminated';

export function deriveSessionState(session: ChatSessionResponse): SessionState {
  if (session.status === 'stopped') return 'terminated';
  if (session.isIdle || session.agentCompletedAt) return 'idle';
  if (session.status === 'active') return 'active';
  return 'terminated';
}

// ---------------------------------------------------------------------------
// DO message → ConversationItem conversion
// ---------------------------------------------------------------------------

/** Converts DO-persisted ChatMessageResponse[] into ConversationItem[] for unified rendering. */
export function chatMessagesToConversationItems(msgs: ChatMessageResponse[]): ConversationItem[] {
  // Safety-net deduplication by message ID. Primary dedup now happens at the
  // state level via mergeMessages(). If this catches duplicates, it indicates
  // a gap in state-level dedup that should be investigated.
  const seenIds = new Set<string>();
  let renderDupCount = 0;
  const dedupedMsgs = msgs.filter((msg) => {
    if (seenIds.has(msg.id)) {
      renderDupCount++;
      return false;
    }
    seenIds.add(msg.id);
    return true;
  });
  if (renderDupCount > 0 && !import.meta.env.PROD) {
    console.warn(`[chatMessagesToConversationItems] Safety-net caught ${renderDupCount} duplicate(s) — investigate state-level dedup gap`);
  }

  // First pass: build items, tracking tool calls by toolCallId for deduplication
  const toolCallMap = new Map<string, number>(); // toolCallId → index in acc
  const items = dedupedMsgs.reduce<ConversationItem[]>((acc, msg) => {
    if (msg.role === 'user') {
      acc.push({ kind: 'user_message', id: msg.id, text: msg.content, timestamp: msg.createdAt });
    } else if (msg.role === 'assistant') {
      // Merge consecutive assistant chunks into one item (same as groupMessages logic)
      const last = acc[acc.length - 1];
      if (last?.kind === 'agent_message') {
        (last as { text: string }).text += msg.content;
      } else {
        acc.push({ kind: 'agent_message', id: msg.id, text: msg.content, streaming: false, timestamp: msg.createdAt });
      }
    } else if (msg.role === 'thinking') {
      // Merge consecutive thinking chunks (same pattern as assistant messages)
      const last = acc[acc.length - 1];
      if (last?.kind === 'thinking') {
        (last as { text: string }).text += msg.content;
      } else {
        acc.push({ kind: 'thinking', id: msg.id, text: msg.content, active: false, timestamp: msg.createdAt });
      }
    } else if (msg.role === 'plan') {
      // Parse plan entries from JSON content
      let entries: Array<{ content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }> = [];
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          entries = parsed.map((e: Record<string, unknown>) => ({
            content: typeof e.content === 'string' ? e.content : '',
            priority: (['high', 'medium', 'low'].includes(e.priority as string) ? e.priority : 'medium') as 'high' | 'medium' | 'low',
            status: (['pending', 'in_progress', 'completed'].includes(e.status as string) ? e.status : 'pending') as 'pending' | 'in_progress' | 'completed',
          }));
        }
      } catch {
        // Invalid JSON — skip this plan message
      }
      if (entries.length > 0) {
        // Plans are replaced wholesale — find existing plan and update it
        const existingIdx = acc.findIndex((i) => i.kind === 'plan');
        const planItem: ConversationItem = {
          kind: 'plan',
          id: existingIdx >= 0 ? (acc[existingIdx]?.id ?? msg.id) : msg.id,
          entries,
          timestamp: msg.createdAt,
        };
        if (existingIdx >= 0) {
          acc[existingIdx] = planItem;
        } else {
          acc.push(planItem);
        }
      }
    } else if (msg.role === 'tool') {
      const meta = msg.toolMetadata as Record<string, unknown> | null;
      const toolCallId = meta && typeof meta.toolCallId === 'string' ? meta.toolCallId : '';
      const kind = meta && typeof meta.kind === 'string' ? meta.kind : 'tool';
      // Build a meaningful title: prefer the explicit title from metadata,
      // then humanize the kind (e.g. "read" → "Read"), and only fall back
      // to the generic "Tool Call" if kind is also just "tool".
      const rawTitle = meta && typeof meta.title === 'string' && meta.title ? meta.title : '';
      const title = rawTitle || (kind && kind !== 'tool'
        ? kind.charAt(0).toUpperCase() + kind.slice(1)
        : 'Tool Call');
      const locations = (meta?.locations as Array<{ path?: string; line?: number | null }>) ?? [];
      const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
      const rawStatus = meta && typeof meta.status === 'string' ? meta.status : '';
      const status = (validStatuses.has(rawStatus)
        ? rawStatus
        : 'completed') as 'pending' | 'in_progress' | 'completed' | 'failed';

      // Use structured content from metadata when available; fall back to raw content field.
      // Content items are now stored as raw ACP JSON (same shape as real-time WebSocket),
      // so we pass them through mapToolCallContent — the same function the real-time path uses.
      const structuredContent = meta?.content as Array<{ type: string } & Record<string, unknown>> | undefined;
      let contentItems: Array<{ type: 'content' | 'diff' | 'terminal'; text?: string; data?: unknown }>;
      if (Array.isArray(structuredContent) && structuredContent.length > 0) {
        contentItems = structuredContent.map((c) => mapToolCallContent(c));
      } else {
        contentItems = isPlaceholderContent(msg.content) ? [] : [{ type: 'content' as const, text: msg.content }];
      }

      // Deduplicate tool calls by toolCallId: merge updates into existing tool call
      if (toolCallId && toolCallMap.has(toolCallId)) {
        const existingIdx = toolCallMap.get(toolCallId)!;
        const existing = acc[existingIdx] as { status: string; title: string; content: unknown[]; locations: unknown[]; toolKind?: string };
        // Update with latest status, title, content, and locations
        if (rawStatus) existing.status = status;
        if (title !== kind) existing.title = title;
        if (contentItems.length > 0) existing.content = contentItems;
        if (locations.length > 0) existing.locations = locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null }));
        if (kind !== 'tool') existing.toolKind = kind;
      } else {
        const idx = acc.length;
        acc.push({
          kind: 'tool_call',
          id: msg.id,
          toolCallId: toolCallId || msg.id,
          title,
          toolKind: kind !== 'tool' ? kind : undefined,
          status,
          content: contentItems,
          locations: locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null })),
          timestamp: msg.createdAt,
        });
        if (toolCallId) {
          toolCallMap.set(toolCallId, idx);
        }
      }
    } else if (msg.role === 'system') {
      // System messages (task status, error logs) rendered as preformatted text
      // to prevent markdown interpretation of build log characters (#, *, URLs)
      acc.push({ kind: 'system_message', id: msg.id, text: msg.content, timestamp: msg.createdAt });
    } else {
      // Unknown roles render as raw fallback (matches workspace chat behavior)
      // to ensure no messages are silently dropped.
      acc.push({
        kind: 'raw_fallback' as const,
        id: msg.id,
        data: { role: msg.role, content: msg.content, toolMetadata: msg.toolMetadata },
        timestamp: msg.createdAt,
      });
    }
    return acc;
  }, []);

  return items;
}
