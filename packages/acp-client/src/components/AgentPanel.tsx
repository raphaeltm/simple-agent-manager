import { useState, useRef, useEffect } from 'react';
import type { AcpSessionHandle } from '../hooks/useAcpSession';
import type { AcpMessagesHandle, ConversationItem } from '../hooks/useAcpMessages';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { UsageIndicator } from './UsageIndicator';
import { ModeSelector } from './ModeSelector';

interface AgentPanelProps {
  session: AcpSessionHandle;
  messages: AcpMessagesHandle;
  /** Available agent modes (from agent capabilities) */
  modes?: string[];
  /** Currently active mode */
  currentMode?: string | null;
  /** Called when user selects a mode */
  onSelectMode?: (mode: string) => void;
}

/**
 * Main conversation container for structured agent interaction.
 * Renders message list, prompt input, and usage indicator.
 */
export function AgentPanel({ session, messages, modes, currentMode, onSelectMode }: AgentPanelProps) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.items.length]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || session.state !== 'ready') return;

    messages.addUserMessage(text);
    session.sendMessage({
      jsonrpc: '2.0',
      method: 'session/prompt',
      id: Date.now(),
      params: {
        prompt: [{ type: 'text', text }],
      },
    });
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const isPrompting = session.state === 'prompting';
  const canSend = session.state === 'ready' && input.trim().length > 0;

  return (
    <div className="flex flex-col h-full bg-gray-50 rounded-lg overflow-hidden">
      {/* Mode selector toolbar */}
      {modes && modes.length > 0 && onSelectMode && (
        <div className="border-b border-gray-200 bg-white px-4 py-2">
          <ModeSelector modes={modes} currentMode={currentMode ?? null} onSelectMode={onSelectMode} />
        </div>
      )}

      {/* Message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
        {messages.items.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Send a message to start the conversation
          </div>
        )}
        {messages.items.map((item) => (
          <ConversationItemView key={item.id} item={item} />
        ))}
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 bg-white p-3">
        <form onSubmit={handleSubmit} className="flex items-end space-x-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={session.state === 'ready' ? 'Send a message...' : 'Waiting for agent...'}
            disabled={session.state !== 'ready'}
            rows={1}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
          {isPrompting && (
            <button
              type="button"
              onClick={() => session.sendMessage({ jsonrpc: '2.0', method: 'session/cancel', params: {} })}
              className="px-3 py-2 text-sm text-red-600 border border-red-300 rounded-md hover:bg-red-50"
            >
              Cancel
            </button>
          )}
        </form>
        {/* Usage indicator */}
        <div className="mt-2 flex justify-end">
          <UsageIndicator usage={messages.usage} />
        </div>
      </div>
    </div>
  );
}

/** Routes a ConversationItem to the appropriate component */
function ConversationItemView({ item }: { item: ConversationItem }) {
  switch (item.kind) {
    case 'user_message':
      return <MessageBubble text={item.text} role="user" />;
    case 'agent_message':
      return <MessageBubble text={item.text} role="agent" streaming={item.streaming} />;
    case 'thinking':
      return <ThinkingBlock text={item.text} active={item.active} />;
    case 'tool_call':
      return <ToolCallCard toolCall={item} />;
    case 'plan':
      return (
        <div className="my-2 border border-gray-200 rounded-lg p-3 bg-white">
          <h4 className="text-xs font-medium text-gray-500 uppercase mb-2">Plan</h4>
          <ul className="space-y-1">
            {item.entries.map((entry, idx) => (
              <li key={idx} className="flex items-center space-x-2 text-sm">
                <span className={`inline-block h-2 w-2 rounded-full ${
                  entry.status === 'completed' ? 'bg-green-400' :
                  entry.status === 'in_progress' ? 'bg-blue-400 animate-pulse' : 'bg-gray-300'
                }`} />
                <span className={entry.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-700'}>
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case 'raw_fallback':
      return (
        <div className="my-2 border border-orange-200 bg-orange-50 rounded-lg p-3">
          <p className="text-xs text-orange-600 font-medium mb-1">Rich rendering unavailable</p>
          <pre className="text-xs text-gray-600 font-mono whitespace-pre-wrap overflow-auto max-h-40">
            {JSON.stringify(item.data, null, 2)}
          </pre>
        </div>
      );
    default:
      return null;
  }
}
