import React, { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle } from 'react';
import type { AcpSessionHandle } from '../hooks/useAcpSession';
import type { AcpMessagesHandle, ConversationItem, PlanItem } from '../hooks/useAcpMessages';
import type { SlashCommand } from '../types';
import { getErrorMeta } from '../errors';
import { useAutoScroll } from '../hooks/useAutoScroll';
import { MessageBubble } from './MessageBubble';
import { ToolCallCard } from './ToolCallCard';
import { ThinkingBlock } from './ThinkingBlock';
import { UsageIndicator } from './UsageIndicator';
import { ModeSelector } from './ModeSelector';
import { SlashCommandPalette } from './SlashCommandPalette';
import type { SlashCommandPaletteHandle } from './SlashCommandPalette';
import { VoiceButton } from './VoiceButton';
import { ChatSettingsPanel } from './ChatSettingsPanel';
import type { ChatSettingsData } from './ChatSettingsPanel';
import { StickyPlanButton } from './StickyPlanButton';
import { PlanModal } from './PlanModal';

// =============================================================================
// Client-side commands (not forwarded to agent)
// =============================================================================

export const CLIENT_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear chat history', source: 'client' },
  { name: 'copy', description: 'Copy last response to clipboard', source: 'client' },
  { name: 'export', description: 'Export conversation as markdown', source: 'client' },
];

export interface AgentPanelHandle {
  /** Focus the chat input textarea. */
  focusInput: () => void;
}

interface AgentPanelProps {
  session: AcpSessionHandle;
  messages: AcpMessagesHandle;
  /** Slash commands provided by the ACP agent */
  availableCommands?: SlashCommand[];
  /** Available agent modes (from agent capabilities) */
  modes?: string[];
  /** Currently active mode */
  currentMode?: string | null;
  /** Called when user selects a mode */
  onSelectMode?: (mode: string) => void;
  /** URL for the voice transcription API endpoint (e.g., https://api.example.com/api/transcribe).
   *  When provided, a voice input button is shown next to the send button. */
  transcribeApiUrl?: string;
  /** Current agent settings (null = not loaded yet) */
  agentSettings?: ChatSettingsData | null;
  /** Whether agent settings are loading */
  agentSettingsLoading?: boolean;
  /** Permission mode options for the settings panel */
  permissionModes?: { value: string; label: string }[];
  /** Called when user saves settings from the in-chat panel */
  onSaveSettings?: (data: { model?: string | null; permissionMode?: string | null }) => Promise<void>;
  /** Optional callback for reporting client-side errors to telemetry */
  onError?: (info: { message: string; source: string; context?: Record<string, unknown> }) => void;
}

/**
 * Main conversation container for structured agent interaction.
 * Renders message list, prompt input, slash command palette, voice button, and usage indicator.
 */
export const AgentPanel = React.forwardRef<AgentPanelHandle, AgentPanelProps>(function AgentPanel({
  session,
  messages,
  availableCommands = [],
  modes,
  currentMode,
  onSelectMode,
  transcribeApiUrl,
  agentSettings,
  agentSettingsLoading,
  permissionModes,
  onSaveSettings,
  onError,
}, ref) {
  const [input, setInput] = useState('');
  const [showPalette, setShowPalette] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const { scrollRef } = useAutoScroll();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const paletteRef = useRef<SlashCommandPaletteHandle>(null);

  // Derive current plan from conversation items (only one plan exists at a time)
  const currentPlan = useMemo(
    () => messages.items.find((i): i is PlanItem => i.kind === 'plan'),
    [messages.items]
  );

  useImperativeHandle(ref, () => ({
    focusInput: () => inputRef.current?.focus(),
  }));

  // Merge agent commands with client commands for the palette
  const allCommands = useMemo(
    () => [...availableCommands, ...CLIENT_COMMANDS],
    [availableCommands]
  );

  // Derive the filter text from the input
  const slashFilter = useMemo(() => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith('/')) return null;
    // Only show palette when the input is a single word starting with /
    // (i.e., no spaces after the command — once they add args, palette hides)
    const afterSlash = trimmed.slice(1);
    if (afterSlash.includes(' ')) return null;
    return afterSlash;
  }, [input]);

  // Show/hide palette based on slash filter
  useEffect(() => {
    setShowPalette(slashFilter !== null);
  }, [slashFilter]);

  // Handle client-side command execution
  const handleClientCommand = useCallback(
    (cmd: SlashCommand, _fullText: string) => {
      switch (cmd.name) {
        case 'clear':
          messages.clear();
          break;
        case 'copy': {
          // Find last agent message and copy it
          const lastAgent = [...messages.items]
            .reverse()
            .find((item) => item.kind === 'agent_message');
          if (lastAgent && lastAgent.kind === 'agent_message') {
            void navigator.clipboard.writeText(lastAgent.text);
          }
          break;
        }
        case 'export': {
          const markdown = exportConversationAsMarkdown(messages.items);
          downloadTextFile(markdown, 'conversation.md');
          break;
        }
      }
    },
    [messages]
  );

  // Handle slash command selection from the palette
  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      setShowPalette(false);
      // For client commands, execute immediately
      if (cmd.source === 'client') {
        handleClientCommand(cmd, `/${cmd.name}`);
        setInput('');
        return;
      }
      // For agent commands, replace input with the command and submit
      const commandText = `/${cmd.name}`;
      setInput('');
      messages.addUserMessage(commandText);
      session.sendMessage({
        jsonrpc: '2.0',
        method: 'session/prompt',
        id: Date.now(),
        params: {
          prompt: [{ type: 'text', text: commandText }],
        },
      });
    },
    [handleClientCommand, messages, session]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || session.state !== 'ready') return;

    // Check for client-side commands
    if (text.startsWith('/')) {
      const cmdName = (text.slice(1).split(' ')[0] ?? '').toLowerCase();
      const clientCmd = CLIENT_COMMANDS.find((c) => c.name === cmdName);
      if (clientCmd) {
        handleClientCommand(clientCmd, text);
        setInput('');
        return;
      }
    }

    // Send to agent as normal
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
    // When palette is visible, delegate navigation keys to it
    if (showPalette && paletteRef.current) {
      const consumed = paletteRef.current.handleKeyDown(e);
      if (consumed) return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  // Handle voice transcription — append transcribed text to current input
  const handleTranscription = useCallback((text: string) => {
    setInput((prev) => {
      const separator = prev.length > 0 && !prev.endsWith(' ') ? ' ' : '';
      return prev + separator + text;
    });
    // Focus the input after transcription so user can review/edit
    inputRef.current?.focus();
  }, []);

  const isPrompting = session.state === 'prompting';
  const isReconnecting = session.state === 'reconnecting';
  const isError = session.state === 'error';
  const canSend = session.state === 'ready' && input.trim().length > 0;

  // Determine placeholder text based on connection state
  const placeholderText = useMemo(() => {
    if (session.state === 'ready') return 'Send a message... (type / for commands)';
    if (isReconnecting) return 'Reconnecting...';
    if (isError && session.errorCode) {
      const meta = getErrorMeta(session.errorCode);
      return meta.userMessage;
    }
    if (isError) return 'Connection lost';
    return 'Waiting for agent...';
  }, [session.state, session.errorCode, isReconnecting, isError]);

  return (
    <div className="flex flex-col h-full bg-gray-50 rounded-lg overflow-hidden">
      {/* Reconnection banner */}
      {isReconnecting && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2 text-sm text-yellow-700 text-center">
          Reconnecting to agent...
        </div>
      )}
      {isError && <ErrorBanner session={session} />}

      {/* Mode selector toolbar */}
      {modes && modes.length > 0 && onSelectMode && (
        <div className="border-b border-gray-200 bg-white px-4 py-2">
          <ModeSelector modes={modes} currentMode={currentMode ?? null} onSelectMode={onSelectMode} />
        </div>
      )}

      {/* Message area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-1">
        {messages.items.length === 0 && !isReconnecting && (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            Send a message to start the conversation
          </div>
        )}
        {messages.items.map((item) => (
          <ConversationItemView key={item.id} item={item} />
        ))}
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 bg-white p-3 relative">
        {/* Settings popover (above input) */}
        {showSettings && onSaveSettings && permissionModes && (
          <ChatSettingsPanel
            settings={agentSettings ?? null}
            loading={agentSettingsLoading}
            permissionModes={permissionModes}
            onSave={onSaveSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
        {/* Sticky plan button (above input) */}
        <StickyPlanButton plan={currentPlan} onClick={() => setShowPlanModal(true)} />
        {currentPlan && (
          <PlanModal plan={currentPlan} isOpen={showPlanModal} onClose={() => setShowPlanModal(false)} />
        )}
        {/* Slash command palette (above input, in document flow) */}
        <SlashCommandPalette
          ref={paletteRef}
          commands={allCommands}
          filter={slashFilter ?? ''}
          onSelect={handleCommandSelect}
          onDismiss={() => setShowPalette(false)}
          visible={showPalette}
        />
        <form onSubmit={handleSubmit} className="flex items-end space-x-2">
            {/* Settings gear button */}
            {onSaveSettings && (
              <button
                type="button"
                onClick={() => setShowSettings((prev) => !prev)}
                className={`p-2 rounded-md border transition-colors flex-shrink-0 ${
                  showSettings
                    ? 'bg-blue-50 border-blue-300 text-blue-600'
                    : 'bg-white border-gray-300 text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                }`}
                style={{ minHeight: 38, minWidth: 38 }}
                aria-label="Agent settings"
                title="Agent settings"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholderText}
              disabled={session.state !== 'ready'}
              rows={1}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm resize-none focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
            />
            {transcribeApiUrl && (
              <VoiceButton
                onTranscription={handleTranscription}
                disabled={session.state !== 'ready'}
                apiUrl={transcribeApiUrl}
                onError={onError}
              />
            )}
            <button
              type="submit"
              disabled={!canSend}
              className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ minHeight: 44 }}
            >
              Send
            </button>
            {isPrompting && (
              <button
                type="button"
                onClick={() => session.sendMessage({ jsonrpc: '2.0', method: 'session/cancel', params: {} })}
                className="px-3 py-2 text-sm text-red-600 border border-red-300 rounded-md hover:bg-red-50"
                style={{ minHeight: 44 }}
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
});

/** Error banner with structured error code, message, and suggested action */
function ErrorBanner({ session }: { session: AcpSessionHandle }) {
  const meta = session.errorCode ? getErrorMeta(session.errorCode) : null;
  const userMessage = meta?.userMessage ?? session.error ?? 'Connection lost';
  const suggestedAction = meta?.suggestedAction;
  const severity = meta?.severity ?? 'recoverable';

  // Color scheme based on severity
  const colors = severity === 'fatal'
    ? { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', hint: 'text-red-600' }
    : severity === 'transient'
      ? { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-800', hint: 'text-yellow-600' }
      : { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', hint: 'text-red-600' };

  const showReconnect = severity !== 'fatal' && session.errorCode !== 'NETWORK_OFFLINE';

  return (
    <div className={`${colors.bg} border-b ${colors.border} px-4 py-2 text-sm text-center`}>
      <div className={`flex items-center justify-center gap-2 ${colors.text}`}>
        <span className="font-medium">{userMessage}</span>
        {showReconnect && (
          <button
            type="button"
            onClick={() => session.reconnect()}
            className="px-3 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700"
            style={{ minHeight: 32 }}
          >
            Reconnect
          </button>
        )}
      </div>
      {suggestedAction && (
        <p className={`text-xs mt-1 ${colors.hint}`}>{suggestedAction}</p>
      )}
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

// =============================================================================
// Helpers for client commands
// =============================================================================

function exportConversationAsMarkdown(items: ConversationItem[]): string {
  const lines: string[] = ['# Conversation Export', '', `Exported: ${new Date().toISOString()}`, ''];

  for (const item of items) {
    switch (item.kind) {
      case 'user_message':
        lines.push(`## User`, '', item.text, '');
        break;
      case 'agent_message':
        lines.push(`## Agent`, '', item.text, '');
        break;
      case 'thinking':
        lines.push(`> **Thinking:** ${item.text}`, '');
        break;
      case 'tool_call':
        lines.push(`### Tool: ${item.title}`, '');
        for (const c of item.content) {
          if (c.text) {
            lines.push('```', c.text, '```', '');
          }
        }
        break;
    }
  }

  return lines.join('\n');
}

function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
