import type { ConversationItem, ToolCallContentItem, ToolCallItem } from '@simple-agent-manager/acp-client';

import type { ChatMessageResponse, ChatSessionResponse, SessionStateSnapshot } from '../../lib/api';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { DOCUMENT_CARD_TOOLS, normalizeToolName } from './tool-cards/document-card-data';

/** Default idle timeout in ms — matches the server-side default (NODE_WARM_TIMEOUT_MS). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Delay (ms) before the auto-resume effect calls the resume API.
 * Configurable via VITE_AUTO_RESUME_DELAY_MS environment variable.
 */
const DEFAULT_AUTO_RESUME_DELAY_MS = 2_000;
export const AUTO_RESUME_DELAY_MS = parseInt(import.meta.env.VITE_AUTO_RESUME_DELAY_MS || String(DEFAULT_AUTO_RESUME_DELAY_MS), 10);

/**
 * Debounce delay (ms) before showing the "Reconnecting..." banner for the DO
 * WebSocket. Brief blips that self-heal within this window are invisible.
 * Configurable via VITE_RECONNECT_BANNER_DELAY_MS environment variable.
 */
const DEFAULT_RECONNECT_BANNER_DELAY_MS = 3_000;
export const RECONNECT_BANNER_DELAY_MS = parseInt(import.meta.env.VITE_RECONNECT_BANNER_DELAY_MS || String(DEFAULT_RECONNECT_BANNER_DELAY_MS), 10);

/**
 * Slow fallback poll used only while the chat WebSocket is not connected.
 * Configurable via VITE_CHAT_FALLBACK_POLL_MS.
 */
const DEFAULT_CHAT_FALLBACK_POLL_MS = 10_000;
export const CHAT_FALLBACK_POLL_MS = Number.parseInt(import.meta.env.VITE_CHAT_FALLBACK_POLL_MS || String(DEFAULT_CHAT_FALLBACK_POLL_MS), 10);

/** Milliseconds of silence after last message before returning to idle (fallback heuristic). */
export const IDLE_TIMEOUT_MS = 30_000;

/** Virtual scroll: starting index for prepend-stable pagination */
export const VIRTUAL_START = 100_000;

/** Agent activity state derived from message flow (no ACP connection needed). */
export type AgentActivityState = 'idle' | 'prompting' | 'responding' | 'recovering';

export function isWorkingActivity(
  activity: SessionStateSnapshot['activity'] | AgentActivityState | undefined | null,
): activity is 'prompting' | 'recovering' {
  return activity === 'prompting' || activity === 'recovering';
}

/** True for placeholder content that adds no user value. */
function isPlaceholderContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === '(tool call)' || trimmed === '(tool update)';
}

function estimateContentSize(content: unknown): number | undefined {
  try {
    return JSON.stringify(content).length;
  } catch {
    return undefined;
  }
}

interface ToolContentPointer {
  messageId: string;
  contentSize?: number;
  hasStoredContent: boolean;
}

function buildToolContentPointer(
  msg: ChatMessageResponse,
  structuredContent: unknown[] | undefined,
  contentSize: number | undefined
): ToolContentPointer {
  const fallbackHasContent = !isPlaceholderContent(msg.content) && msg.content.trim().length > 0;
  const hasStructuredContent = Array.isArray(structuredContent) && structuredContent.length > 0;
  const estimatedSize = hasStructuredContent
    ? estimateContentSize(structuredContent)
    : fallbackHasContent
      ? msg.content.length
      : undefined;
  return {
    messageId: msg.id,
    contentSize: contentSize ?? estimatedSize,
    hasStoredContent: hasStructuredContent || fallbackHasContent || (contentSize !== undefined && contentSize > 0),
  };
}

function applyToolContentPointer(toolItem: ToolCallItem, pointer: ToolContentPointer, force = false): void {
  if (!force && toolItem.messageId && !pointer.hasStoredContent) {
    return;
  }

  toolItem.messageId = pointer.messageId;
  toolItem.contentLoaded = false;
  toolItem.content = [];
  if (pointer.contentSize !== undefined) {
    toolItem.contentSize = pointer.contentSize;
  }
}

/**
 * Recover a stable tool identifier from the ACP title when the metadata omits
 * an explicit `toolName` (e.g. Codex, which passes `<server>/<tool>` as the
 * title and sets no `_meta.claudeCode.toolName`). Delimiter-agnostic: returns
 * the title when it normalizes to a known typed-card tool, or when it follows
 * the legacy `mcp__<server>__<tool>` convention. Returns undefined for plain
 * human titles so they are not mistaken for tool identifiers.
 */
function inferToolNameFromTitle(title: string): string | undefined {
  if (!title) return undefined;
  const base = normalizeToolName(title);
  if (base && DOCUMENT_CARD_TOOLS.has(base)) return title;
  if (title.startsWith('mcp__') && title.split('__').length >= 3) return title;
  return undefined;
}

function isDocumentCardTool(toolName: string | undefined): boolean {
  const base = normalizeToolName(toolName);
  return Boolean(base && DOCUMENT_CARD_TOOLS.has(base));
}

function parseJsonRecordFromToolContent(content: string): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  if (!trimmed || isPlaceholderContent(trimmed)) return undefined;

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      return maybeJsonRecord(parsed) ?? undefined;
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function legacyDocumentRawOutput(toolName: string | undefined, content: string): unknown {
  if (!isDocumentCardTool(toolName)) return undefined;
  const payload = parseJsonRecordFromToolContent(content);
  return payload ? [{ type: 'text', text: JSON.stringify(payload) }] : undefined;
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
      acc.push({
        kind: 'user_message',
        id: msg.id,
        text: msg.content,
        timestamp: msg.createdAt,
        origin: msg.origin === 'system' ? 'system' : 'user',
      });
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
      const meta = maybeJsonRecord(msg.toolMetadata);
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
      // Card-critical fields for typed tool-call cards. toolName is the stable
      // discriminator; rawInput/rawOutput carry the payload (fileId, filename,
      // mimeType, sizeBytes, caption) and survive compact-mode content stripping.
      const toolName = meta && typeof meta.toolName === 'string' && meta.toolName
        ? meta.toolName
        : inferToolNameFromTitle(rawTitle);
      const rawInput = meta ? meta.rawInput : undefined;
      const rawOutput = meta?.rawOutput ?? legacyDocumentRawOutput(toolName, msg.content);
      const validStatuses = new Set(['pending', 'in_progress', 'completed', 'failed']);
      const rawStatus = meta && typeof meta.status === 'string' ? meta.status : '';
      const status = (validStatuses.has(rawStatus)
        ? rawStatus
        : 'completed') as 'pending' | 'in_progress' | 'completed' | 'failed';

      // Project chat loads tool output on demand from the persisted message.
      // Live WebSocket rows and compact history rows are normalized to the
      // same lazy-load pointer so inline content cannot disappear on refresh.
      const structuredContent = meta?.content as Array<{ type: string } & Record<string, unknown>> | undefined;
      const contentSize = typeof meta?.contentSize === 'number' ? meta.contentSize : undefined;
      const contentPointer = buildToolContentPointer(msg, structuredContent, contentSize);
      const contentItems: ToolCallContentItem[] = [];

      // Deduplicate tool calls by toolCallId: merge updates into existing tool call
      if (toolCallId && toolCallMap.has(toolCallId)) {
        const existingIdx = toolCallMap.get(toolCallId);
        if (existingIdx === undefined) {
          return acc;
        }
        const existing = acc[existingIdx] as ToolCallItem;
        // Update with latest status, explicit title, content, and locations.
        // Status-only tool_call_update rows often omit title/kind; do not let
        // the generic fallback title erase the richer initial tool_call title.
        if (rawStatus) existing.status = status;
        if (rawTitle) existing.title = rawTitle;
        if (locations.length > 0) existing.locations = locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null }));
        if (kind !== 'tool') existing.toolKind = kind;
        // Preserve-on-empty: a status-only tool_call_update must not erase the
        // toolName/rawInput/rawOutput captured from the initial tool_call (the
        // result update carries rawOutput; the initial carries rawInput).
        if (toolName) existing.toolName = toolName;
        if (rawInput !== undefined) existing.rawInput = rawInput;
        if (rawOutput !== undefined) existing.rawOutput = rawOutput;
        applyToolContentPointer(existing, contentPointer);
      } else {
        const idx = acc.length;
        const toolItem: ToolCallItem = {
          kind: 'tool_call',
          id: msg.id,
          toolCallId: toolCallId || msg.id,
          title,
          toolKind: kind !== 'tool' ? kind : undefined,
          status,
          content: contentItems,
          locations: locations.map((l) => ({ path: l.path ?? '', line: l.line ?? null })),
          timestamp: msg.createdAt,
          toolName,
          rawInput,
          rawOutput,
        };
        applyToolContentPointer(toolItem, contentPointer, true);
        acc.push(toolItem);
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
