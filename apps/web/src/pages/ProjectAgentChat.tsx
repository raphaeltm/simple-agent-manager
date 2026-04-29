/**
 * Project Agent chat page — per-project AI technical lead.
 * Shares useAgentChat hook, MessageBubble, and SamMarkdown with the top-level SAM chat.
 * Includes WebGL swirl background and voice input, matching the SAM top-level agent.
 */
import { Bot, Loader2, Mic, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useParams } from 'react-router';

import { useAgentChat } from '../hooks/useAgentChat';
import { API_URL } from '../lib/api/client';
import { useProjectContext } from './ProjectContext';
import { glass, glow, MessageBubble } from './sam-prototype/components';
import { useVoiceInput } from './sam-prototype/voice-input';
import { useWebGLBackground } from './sam-prototype/webgl-background';

export function ProjectAgentChat() {
  const { id: projectId } = useParams<{ id: string }>();
  const { project } = useProjectContext();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const amplitudeRef = useRef(0);

  const chat = useAgentChat({ apiBase: `/api/projects/${projectId}/agent` });
  const { setInputValue: setChatInputValue } = chat;

  const agentLabel = project?.name ?? 'Project Agent';

  // WebGL swirl background driven by voice amplitude
  useWebGLBackground(canvasRef, amplitudeRef);

  // Voice input hook
  const voice = useVoiceInput({
    transcribeUrl: `${API_URL}/api/transcribe`,
    amplitudeRef,
    onTranscription: useCallback(
      (text: string) => {
        setChatInputValue((prev: string) => (prev ? `${prev} ${text}` : text));
      },
      [setChatInputValue],
    ),
  });

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

  // Mic button style based on voice state
  const micButtonStyle: React.CSSProperties = (() => {
    if (voice.state === 'recording') {
      return {
        background: 'rgba(60, 180, 120, 0.35)',
        border: '1px solid rgba(60, 180, 120, 0.5)',
        boxShadow: '0 0 20px rgba(60, 180, 120, 0.4), 0 0 40px rgba(60, 180, 120, 0.15)',
      };
    }
    if (voice.state === 'processing') {
      return {
        background: 'rgba(60, 180, 120, 0.2)',
        border: '1px solid rgba(60, 180, 120, 0.3)',
      };
    }
    if (voice.state === 'error') {
      return {
        background: 'rgba(239, 68, 68, 0.2)',
        border: '1px solid rgba(239, 68, 68, 0.3)',
      };
    }
    return {
      background: 'rgba(255, 255, 255, 0.05)',
      border: '1px solid rgba(60, 180, 120, 0.15)',
    };
  })();

  return (
    <div className="flex flex-col h-full relative overflow-hidden">
      {/* WebGL background canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ zIndex: 0 }}
      />

      {/* Content layer */}
      <div className="relative z-10 flex flex-col h-full">
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
        <div
          className="flex-1 overflow-y-auto px-4 py-4"
          aria-live="polite"
          aria-label="Conversation"
        >
          {chat.isLoadingHistory ? (
            <div className="flex items-center justify-center py-8" role="status" aria-label="Loading conversation history">
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
          {/* Voice error message */}
          {voice.errorMsg && (
            <div className="text-xs text-red-400/80 text-center mb-2">{voice.errorMsg}</div>
          )}
          {/* Recording indicator */}
          {voice.state === 'recording' && (
            <div className="flex items-center justify-center gap-2 mb-2">
              <div
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: '#3cb480', boxShadow: '0 0 8px rgba(60, 180, 120, 0.6)' }}
              />
              <span className="text-xs text-white/50">Listening... tap mic to stop</span>
            </div>
          )}
          {voice.state === 'processing' && (
            <div className="flex items-center justify-center gap-2 mb-2">
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#3cb480' }} />
              <span className="text-xs text-white/50">Transcribing...</span>
            </div>
          )}
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
              placeholder={
                voice.state === 'recording'
                  ? 'Speak now...'
                  : `Ask ${agentLabel} anything...`
              }
              aria-label={`Message ${agentLabel}`}
              aria-multiline="true"
              className="flex-1 px-4 py-3 text-sm rounded-xl text-white placeholder:text-white/25 outline-none resize-none overflow-hidden leading-snug focus-visible:ring-1 focus-visible:ring-[rgba(60,180,120,0.5)]"
              style={
                {
                  ...glass.input,
                  transition: 'height 0.15s ease-out',
                  minHeight: '44px',
                } as React.CSSProperties
              }
            />
            {/* Mic button */}
            <button
              type="button"
              onClick={voice.toggle}
              disabled={voice.state === 'processing' || chat.isSending}
              className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
              style={micButtonStyle}
              title={
                voice.state === 'recording'
                  ? 'Stop recording'
                  : voice.state === 'processing'
                    ? 'Transcribing...'
                    : 'Voice input'
              }
              aria-label={
                voice.state === 'recording'
                  ? 'Stop recording'
                  : 'Start voice input'
              }
            >
              {voice.state === 'recording' ? (
                <Square className="w-4 h-4" fill="currentColor" />
              ) : voice.state === 'processing' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>
            {/* Send button */}
            <button
              type="button"
              onClick={() => void chat.handleSend()}
              disabled={!chat.inputValue.trim() || chat.isSending}
              aria-label={chat.isSending ? 'Sending message…' : 'Send message'}
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
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="w-4 h-4" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
