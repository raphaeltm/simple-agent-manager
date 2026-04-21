import type { ConversationItem } from '@simple-agent-manager/acp-client';
import {
  MessageBubble as AcpMessageBubble,
  PlanView,
  RawFallbackView,
  ThinkingBlock as AcpThinkingBlock,
  ToolCallCard as AcpToolCallCard,
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

/** Renders a single ACP ConversationItem using the shared acp-client components. */
export function AcpConversationItemView({ item, onFileClick }: { item: ConversationItem; onFileClick?: (path: string, line?: number | null) => void }) {
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
      return <AcpMessageBubble text={item.text} role="agent" streaming={item.streaming} timestamp={item.timestamp} ttsApiUrl={getTtsUrl()} ttsStorageId={item.id} onPlayAudio={handlePlayAudio} onFileClick={onFileClick} />;
    case 'thinking':
      return <AcpThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call':
      return <AcpToolCallCard toolCall={item} onFileClick={onFileClick} />;
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
