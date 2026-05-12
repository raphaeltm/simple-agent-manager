import type { ConversationItem, ToolCallContentItem } from '@simple-agent-manager/acp-client';
import {
  MessageBubble as AcpMessageBubble,
  PlanView,
  RawFallbackView,
  ThinkingBlock as AcpThinkingBlock,
  ToolCallCard as AcpToolCallCard,
  TypewriterText,
} from '@simple-agent-manager/acp-client';

import { useGlobalAudio } from '../../contexts/GlobalAudioContext';
import { getTtsApiUrl } from '../../lib/api';

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
        className="max-w-[90%] min-w-0 rounded-lg px-4 py-3 border overflow-hidden"
        style={{
          backgroundColor: 'var(--sam-color-bg-inset)',
          borderColor: 'var(--sam-color-border-default)',
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

/** Renders a single ACP ConversationItem using the shared acp-client components.
 *  When `animateText` is true for agent_message items, TypewriterText provides
 *  word-by-word animation of the latest batch. */
export function AcpConversationItemView({ item, onFileClick, onLoadToolContent, animateText }: {
  item: ConversationItem;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
  /** When true, agent_message text is animated with TypewriterText. */
  animateText?: boolean;
}) {
  const globalAudio = useGlobalAudio();

  const handlePlayAudio = item.kind === 'agent_message'
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
      return <AcpMessageBubble text={item.text} role="user" />;
    case 'agent_message':
      if (animateText) {
        return (
          <div className="flex justify-start mb-4">
            <div
              className="max-w-[80%] min-w-0 rounded-lg px-4 py-3 bg-white border border-gray-200 text-gray-900"
            >
              <div className="prose prose-sm max-w-none overflow-x-auto break-words whitespace-pre-wrap">
                <TypewriterText text={item.text} animated={true} />
              </div>
              <span className="inline-block mt-1 text-xs opacity-60 animate-pulse">...</span>
            </div>
          </div>
        );
      }
      return <AcpMessageBubble text={item.text} role="agent" streaming={item.streaming} timestamp={item.timestamp} ttsApiUrl={getTtsUrl()} ttsStorageId={item.id} onPlayAudio={handlePlayAudio} onFileClick={onFileClick} />;
    case 'thinking':
      return <AcpThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call':
      return <AcpToolCallCard toolCall={item} onFileClick={onFileClick} onLoadContent={onLoadToolContent} />;
    case 'plan':
      return <PlanView plan={item} />;
    case 'system_message':
      return <SystemMessageBubble text={item.text} />;
    case 'raw_fallback':
      return <RawFallbackView item={item} />;
    default:
      return null;
  }
}
