import type { ConversationItem, ToolCallContentItem } from '@simple-agent-manager/acp-client';
import {
  AgentCrashReportView,
  MessageBubble as AcpMessageBubble,
  PlanView,
  RawFallbackView,
  ThinkingBlock as AcpThinkingBlock,
  ToolCallCard as AcpToolCallCard,
  UserMessageFade,
} from '@simple-agent-manager/acp-client';

import { useGlobalAudio } from '../../contexts/GlobalAudioContext';
import { getTtsApiUrl } from '../../lib/api';
import { matchToolCard } from './tool-cards';

/** Lazily computed TTS API URL — avoids module-scope errors in test environments. */
let _cachedTtsApiUrl: string | undefined;
function getTtsUrl(): string {
  if (!_cachedTtsApiUrl) _cachedTtsApiUrl = getTtsApiUrl();
  return _cachedTtsApiUrl;
}

/** Renders a system message (task status, error logs) as preformatted text.
 *  Prevents markdown interpretation of build log characters (#, *, URLs). */
export function SystemMessageBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start mb-4">
      <div
        role="region"
        aria-label="System message"
        className="max-w-[90%] min-w-0 rounded-lg px-4 py-2 border overflow-hidden"
        style={{
          backgroundColor: 'rgba(22, 163, 74, 0.06)',
          borderColor: 'rgba(34, 197, 94, 0.1)',
        }}
      >
        <div className="flex items-center gap-1.5 mb-2">
          <span
            className="text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--sam-color-fg-muted)' }}
          >
            System
          </span>
        </div>
        <pre
          className="text-xs whitespace-pre-wrap break-words m-0 font-mono leading-relaxed"
          style={{ color: 'var(--sam-color-fg-primary)' }}
        >
          {text}
        </pre>
      </div>
    </div>
  );
}

/** Renders a SAM-injected (origin="system") user message collapsed behind a
 *  native <details> disclosure with a chevron, so injected instructions (e.g. the
 *  get_instructions reminder) don't clutter the chat. Right-aligned to match the
 *  user-message column. Expandable to reveal the exact injected text. */
export function CollapsedInjectedMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end mb-4">
      <details className="sam-injected-message group max-w-[92%] sm:max-w-[80%] min-w-0 rounded-lg border border-border-default overflow-hidden">
        <summary
          className="cursor-pointer select-none list-none min-h-11 px-3 py-2 text-xs flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          <span
            aria-hidden="true"
            className="sam-injected-chevron transition-transform group-open:rotate-90"
          >
            ▸
          </span>
          <span>Show system context</span>
        </summary>
        <pre
          className="text-xs whitespace-pre-wrap break-words m-0 px-3 py-2 font-mono leading-relaxed border-t border-border-default"
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          {text}
        </pre>
      </details>
    </div>
  );
}

/** Renders a single ACP ConversationItem using the shared acp-client components.
 *  When `animateText` is true for agent_message items, MessageBubble renders with
 *  per-character fade-in animation via TypewriterText. */
export function AcpConversationItemView({
  item,
  onFileClick,
  onLoadToolContent,
  animateText,
  animateUserMessage,
  projectId,
}: {
  item: ConversationItem;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
  /** When true, agent_message text is animated with per-character fade. */
  animateText?: boolean;
  /** When true, user_message text is animated with per-character fade. */
  animateUserMessage?: boolean;
  /** Project context — enables typed tool-call cards (e.g. DocumentCard previews). */
  projectId?: string;
}) {
  const globalAudio = useGlobalAudio();

  const handlePlayAudio =
    item.kind === 'agent_message'
      ? () => {
          const ttsApiUrl = getTtsUrl();
          const ttsStorageId = item.id;
          if (ttsApiUrl && ttsStorageId) {
            globalAudio.startPlayback({
              text: item.text,
              ttsApiUrl,
              ttsStorageId,
              label: 'Chat message',
              sourceText: item.text.slice(0, 200),
            });
          }
        }
      : undefined;

  switch (item.kind) {
    case 'user_message':
      if (item.origin === 'system') {
        return <CollapsedInjectedMessage text={item.text} />;
      }
      if (animateUserMessage) {
        return (
          <div className="flex justify-end mb-4">
            <div className="max-w-[80%] min-w-0 rounded-lg px-4 py-3 glass-msg-user">
              <div className="prose prose-sm max-w-none overflow-x-auto break-words">
                <UserMessageFade text={item.text} />
              </div>
            </div>
          </div>
        );
      }
      return <AcpMessageBubble text={item.text} role="user" bubbleClassName="glass-msg-user" />;
    case 'agent_message':
      return (
        <AcpMessageBubble
          text={item.text}
          role="agent"
          streaming={item.streaming}
          animated={animateText}
          timestamp={item.timestamp}
          ttsApiUrl={getTtsUrl()}
          ttsStorageId={item.id}
          onPlayAudio={handlePlayAudio}
          onFileClick={onFileClick}
          bubbleClassName="glass-msg-assistant"
        />
      );
    case 'thinking':
      return <AcpThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call': {
      // Typed tool-call cards (e.g. DocumentCard) render in place of the generic
      // card when the tool matches the registry; unknown tools fall back.
      const TypedCard = matchToolCard(item);
      if (TypedCard) {
        return <TypedCard item={item} projectId={projectId} />;
      }
      return (
        <AcpToolCallCard
          toolCall={item}
          onFileClick={onFileClick}
          onLoadContent={onLoadToolContent}
          className={
            item.contentLoaded === false
              ? 'glass-surface rounded-md border-border-default'
              : undefined
          }
        />
      );
    }
    case 'plan':
      return <PlanView plan={item} />;
    case 'system_message':
      return <SystemMessageBubble text={item.text} />;
    case 'agent_crash_report':
      return <AgentCrashReportView item={item} />;
    case 'raw_fallback':
      return <RawFallbackView item={item} />;
    default:
      return null;
  }
}
