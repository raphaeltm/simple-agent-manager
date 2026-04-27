import {
  ArrowLeft,
  Bot,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Mic,
  Send,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_URL } from '../lib/api/client';
import type { ChatMessage, MockProject } from './sam-prototype/components';
import {
  glass,
  glow,
  MessageBubble,
  MOCK_PROJECTS,
  ProjectDetail,
  ProjectNode,
  StatsBar,
} from './sam-prototype/components';
import { useVoiceInput } from './sam-prototype/voice-input';
import { useWebGLBackground } from './sam-prototype/webgl-background';

export function SamPrototype() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const amplitudeRef = useRef(0);
  const [view, setView] = useState<'chat' | 'overview'>('chat');
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selectedProject, setSelectedProject] = useState<MockProject | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useWebGLBackground(canvasRef, amplitudeRef);

  // Voice input hook
  const voice = useVoiceInput({
    transcribeUrl: `${API_URL}/api/transcribe`,
    amplitudeRef,
    onTranscription: useCallback(
      (text: string) => {
        setInputValue((prev) => (prev ? `${prev} ${text}` : text));
      },
      [],
    ),
  });

  // Auto-resize textarea: shrink to content, max ~3.5 lines (~84px at 14px font/1.5 line-height)
  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px'; // collapse to measure scrollHeight
    // Single line = ~21px, 3.5 lines ~ 74px. Clamp to max.
    const maxHeight = 84;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [inputValue, resizeTextarea]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /** Send a message to SAM and stream the response via SSE. */
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isSending) return;

    setInputValue('');
    setIsSending(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    };
    setMessages((prev) => [...prev, userMsg]);

    const samMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        id: samMsgId,
        role: 'sam',
        content: '',
        timestamp: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        toolCalls: [],
        isStreaming: true,
      },
    ]);

    try {
      abortRef.current = new AbortController();
      const response = await fetch(`${API_URL}/api/sam/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: text }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((errData as { error?: string }).error || `HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = event.type as string;

          if (eventType === 'conversation_started') {
            setConversationId(event.conversationId as string);
          } else if (eventType === 'text_delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? { ...m, content: m.content + (event.content as string) }
                  : m,
              ),
            );
          } else if (eventType === 'tool_start') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? {
                      ...m,
                      toolCalls: [...(m.toolCalls || []), { name: event.tool as string }],
                    }
                  : m,
              ),
            );
          } else if (eventType === 'tool_result') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== samMsgId) return m;
                const calls = [...(m.toolCalls || [])];
                const idx = calls.findIndex((tc) => tc.name === event.tool && !tc.result);
                if (idx >= 0) calls[idx] = { name: calls[idx]!.name, result: event.result };
                return { ...m, toolCalls: calls };
              }),
            );
          } else if (eventType === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === samMsgId
                  ? {
                      ...m,
                      content:
                        m.content + `\n\n**Error:** ${event.message as string}`,
                      isStreaming: false,
                    }
                  : m,
              ),
            );
          } else if (eventType === 'done') {
            setMessages((prev) =>
              prev.map((m) => (m.id === samMsgId ? { ...m, isStreaming: false } : m)),
            );
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === samMsgId ? { ...m, isStreaming: false } : m)),
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === samMsgId
            ? {
                ...m,
                content:
                  m.content || `Failed to get response: ${(err as Error).message}`,
                isStreaming: false,
              }
            : m,
        ),
      );
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  }, [inputValue, isSending, conversationId]);

  const handleAskAboutProject = useCallback((name: string) => {
    setSelectedProject(null);
    setView('chat');
    setInputValue(`Tell me more about ${name}`);
  }, []);

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
    <div className="h-dvh flex flex-col relative overflow-hidden">
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
          <a
            href="/dashboard"
            className="p-1 -ml-1 rounded-md transition-colors"
            style={{ color: 'rgba(255,255,255,0.4)' }}
          >
            <ArrowLeft className="w-5 h-5" />
          </a>
          <div className="flex items-center gap-2 flex-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center"
              style={{
                background: 'rgba(60, 180, 120, 0.15)',
                boxShadow: '0 0 12px rgba(60, 180, 120, 0.2)',
              }}
            >
              <Bot className="w-4 h-4" style={{ color: '#3cb480' }} />
            </div>
            <h1 className="text-base font-semibold text-white/90">SAM</h1>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {/* Chat */}
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-out ${
              view === 'chat' ? 'translate-x-0' : '-translate-x-full'
            }`}
          >
            <div className="flex-1 overflow-y-auto px-4 py-4">
              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="shrink-0 px-4 pt-2 pb-24">
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
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder={
                    voice.state === 'recording'
                      ? 'Speak now...'
                      : 'Ask SAM anything...'
                  }
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
                {/* Mic button */}
                <button
                  type="button"
                  onClick={voice.toggle}
                  disabled={voice.state === 'processing' || isSending}
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
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isSending}
                  className="p-3 rounded-xl text-white disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                  style={{
                    background:
                      inputValue.trim() && !isSending
                        ? 'rgba(60, 180, 120, 0.3)'
                        : 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(60, 180, 120, 0.25)',
                    ...(inputValue.trim() && !isSending ? glow.accent : {}),
                  }}
                >
                  {isSending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Overview */}
          <div
            className={`absolute inset-0 flex flex-col transition-transform duration-300 ease-out ${
              view === 'overview' ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <StatsBar />
            <div className="flex-1 overflow-y-auto p-4 pb-24 space-y-3">
              {MOCK_PROJECTS.map((project) => (
                <ProjectNode
                  key={project.id}
                  project={project}
                  onTap={() => setSelectedProject(project)}
                />
              ))}
            </div>
            {selectedProject && (
              <ProjectDetail
                project={selectedProject}
                onClose={() => setSelectedProject(null)}
                onAsk={handleAskAboutProject}
              />
            )}
          </div>
        </div>

        {/* Floating bottom tab bar */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30">
          <div
            className="flex rounded-2xl overflow-hidden"
            style={{ ...glass.tabBar, ...glow.green }}
          >
            <button
              type="button"
              onClick={() => setView('chat')}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all"
              style={{
                color: view === 'chat' ? '#3cb480' : 'rgba(255,255,255,0.4)',
                background: view === 'chat' ? 'rgba(60, 180, 120, 0.12)' : 'transparent',
              }}
            >
              <MessageSquare className="w-4.5 h-4.5" />
              Chat
            </button>
            <div
              style={{
                width: '1px',
                background: 'rgba(60, 180, 120, 0.15)',
                margin: '8px 0',
              }}
            />
            <button
              type="button"
              onClick={() => setView('overview')}
              className="flex items-center gap-2 px-5 py-3 text-sm font-medium transition-all"
              style={{
                color: view === 'overview' ? '#3cb480' : 'rgba(255,255,255,0.4)',
                background:
                  view === 'overview' ? 'rgba(60, 180, 120, 0.12)' : 'transparent',
              }}
            >
              <LayoutDashboard className="w-4.5 h-4.5" />
              Overview
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
