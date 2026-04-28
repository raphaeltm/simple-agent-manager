/**
 * Project Agent chat page — per-project AI technical lead.
 * Shares useAgentChat hook, MessageBubble, and SamMarkdown with the top-level SAM chat.
 */
import { Bot, Loader2, Send } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router';

import { useAgentChat } from '../hooks/useAgentChat';
import { useProjectContext } from './ProjectContext';
import { glass, glow, MessageBubble } from './sam-prototype/components';

export function ProjectAgentChat() {
  const { id: projectId } = useParams<{ id: string }>();
  const { project } = useProjectContext();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const chat = useAgentChat({ apiBase: `/api/projects/${projectId}/agent` });

  const agentLabel = project?.name ?? 'Project Agent';

  // Auto-resize textarea
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    const maxHeight = 84;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [chat.inputValue, resizeTextarea]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages]);

  return (
    <div className="flex flex-col h-full relative overflow-hidden" style={{ background: 'rgba(2, 8, 5, 0.95)' }}>
      {/* Header */}
      <header className="shrink-0 px-4 py-3 flex items-center gap-3" style={glass.header}>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{
              background: 'rgba(60, 180, 120, 0.15)',
              boxShadow: '0 0 12px rgba(60, 180, 120, 0.2)',
            }}
          >
            <Bot className="w-4 h-4" style={{ color: '#3cb480' }} />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-white/90 truncate">{agentLabel}</h1>
            <p className="text-xs text-white/40">Project Agent</p>
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {chat.isLoadingHistory ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'rgba(60, 180, 120, 0.5)' }} />
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(60, 180, 120, 0.1)',
                boxShadow: '0 0 24px rgba(60, 180, 120, 0.15)',
              }}
            >
              <Bot className="w-7 h-7" style={{ color: '#3cb480' }} />
            </div>
            <div className="text-center max-w-sm">
              <h2 className="text-base font-semibold text-white/80 mb-1">{agentLabel}</h2>
              <p className="text-sm text-white/40 leading-relaxed">
                Your project&apos;s AI tech lead. Ask about tasks, codebase, knowledge, CI status, or dispatch work to coding agents.
              </p>
            </div>
          </div>
        ) : (
          chat.messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} agentLabel={agentLabel} />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 px-4 pt-2 pb-4">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            value={chat.inputValue}
            onChange={(e) => chat.setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void chat.handleSend();
              }
            }}
            placeholder={`Ask ${agentLabel} anything...`}
            className="flex-1 px-4 py-3 text-sm rounded-xl text-white placeholder:text-white/25 focus:outline-none focus:ring-1 resize-none overflow-hidden leading-snug"
            style={
              {
                ...glass.input,
                focusRingColor: 'rgba(60, 180, 120, 0.3)',
                transition: 'height 0.15s ease-out',
                minHeight: '44px',
              } as React.CSSProperties
            }
          />
          <button
            type="button"
            onClick={() => void chat.handleSend()}
            disabled={!chat.inputValue.trim() || chat.isSending}
            className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
            style={{
              background:
                chat.inputValue.trim() && !chat.isSending
                  ? 'rgba(60, 180, 120, 0.3)'
                  : 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(60, 180, 120, 0.25)',
              ...(chat.inputValue.trim() && !chat.isSending ? glow.accent : {}),
            }}
          >
            {chat.isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
