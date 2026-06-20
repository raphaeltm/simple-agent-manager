import { ArrowLeftRight, ChevronLeft, Maximize2, Minimize2, Plus, Search, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  GLOBAL_NAV,
  MOCK_CONVERSATION,
  MOCK_SESSIONS,
  type MockSession,
  type SessionStatus,
} from './mock-data';

/**
 * Sidebar Collapse Prototype — Focus Mode
 *
 * Throwaway design exploration (see .claude/rules/37-prototype-development.md).
 * Demonstrates a coordinated three-state "Focus Mode" toggle that collapses
 * BOTH desktop sidebars (main nav + project chat sessions) together:
 *
 *   Default → full 220px nav rail + 288px session list (today's layout)
 *   Focus   → 56px icon rail nav + slim live status strip sessions
 *   Zen     → both tucked to glowing edge seams; hover a seam to peek
 *
 * Self-contained: no API calls, no auth, mock data only.
 */

type FocusMode = 'default' | 'focus' | 'zen';

const MODE_ORDER: FocusMode[] = ['default', 'focus', 'zen'];

const STATUS_DOT: Record<SessionStatus, string> = {
  running: 'bg-[var(--sam-color-accent-primary,#16a34a)]',
  done: 'bg-fg-muted',
  failed: 'bg-danger-fg',
  idle: 'bg-border-default',
};

const STATUS_RING: Record<SessionStatus, string> = {
  running: 'ring-[var(--sam-color-accent-primary,#16a34a)]',
  done: 'ring-transparent',
  failed: 'ring-danger-fg',
  idle: 'ring-transparent',
};

function modeLabel(mode: FocusMode): string {
  if (mode === 'default') return 'Default';
  if (mode === 'focus') return 'Focus';
  return 'Zen';
}

function nextMode(mode: FocusMode): FocusMode {
  const idx = MODE_ORDER.indexOf(mode);
  return MODE_ORDER[(idx + 1) % MODE_ORDER.length] ?? 'default';
}

export default function SidebarCollapsePrototype() {
  const [mode, setMode] = useState<FocusMode>('default');
  const [peekNav, setPeekNav] = useState(false);
  const [peekSessions, setPeekSessions] = useState(false);

  const cycle = useCallback(() => setMode((m) => nextMode(m)), []);

  // Press "F" to cycle focus mode, like the real toggle would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
        e.preventDefault();
        cycle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  // ── Derived widths ────────────────────────────────────────────────
  // Nav: 220 default, 56 focus, 0 zen (peek overlays at 220).
  const navIconOnly = mode === 'focus';
  const navHidden = mode === 'zen' && !peekNav;

  // Sessions: 288 default, 64 strip in focus, 0 zen (peek overlays at 288).
  const sessionsStrip = mode === 'focus';
  const sessionsHidden = mode === 'zen' && !peekSessions;

  return (
    <div className="h-screen w-screen overflow-hidden bg-canvas text-fg-primary flex flex-col">
      {/* Prototype top bar with the Focus Mode toggle */}
      <header className="relative z-40 flex items-center justify-between gap-3 px-4 py-2 glass-chrome glass-panel-container glass-composited border-x-0 border-t-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles size={16} className="text-accent shrink-0" />
          <span className="text-sm font-semibold truncate">Sidebar Collapse — Focus Mode prototype</span>
        </div>
        <FocusModeToggle mode={mode} onCycle={cycle} onSet={setMode} />
      </header>

      <div className="relative flex-1 min-h-0 flex">
        {/* ── Main nav sidebar ─────────────────────────────────────── */}
        <NavRail iconOnly={navIconOnly} hidden={navHidden} peeking={peekNav} mode={mode} />

        {/* Zen seam for nav — hover to peek */}
        {mode === 'zen' && (
          <EdgeSeam
            side="left"
            label="Navigation"
            onEnter={() => setPeekNav(true)}
            onLeave={() => setPeekNav(false)}
          />
        )}

        {/* ── Project chat sessions sidebar ───────────────────────── */}
        <SessionPanel
          strip={sessionsStrip}
          hidden={sessionsHidden}
          peeking={peekSessions}
          mode={mode}
        />

        {/* Zen seam for sessions — hover to peek */}
        {mode === 'zen' && (
          <EdgeSeam
            side="left"
            label="Chats"
            inset
            onEnter={() => setPeekSessions(true)}
            onLeave={() => setPeekSessions(false)}
          />
        )}

        {/* ── Conversation column ─────────────────────────────────── */}
        <ConversationColumn mode={mode} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Focus Mode toggle — segmented control + cycle button
// ───────────────────────────────────────────────────────────────────
function FocusModeToggle({
  mode,
  onCycle,
  onSet,
}: {
  mode: FocusMode;
  onCycle: () => void;
  onSet: (m: FocusMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <div className="flex items-center rounded-sm border border-border-default overflow-hidden">
        {MODE_ORDER.map((m) => {
          const active = m === mode;
          const Icon = m === 'default' ? Maximize2 : m === 'focus' ? Minimize2 : Sparkles;
          return (
            <button
              key={m}
              onClick={() => onSet(m)}
              aria-pressed={active}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? 'bg-[var(--sam-chrome-accent-active-subtle)] text-accent'
                  : 'bg-transparent text-fg-muted hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)]'
              }`}
            >
              <Icon size={13} />
              <span className="hidden sm:inline">{modeLabel(m)}</span>
            </button>
          );
        })}
      </div>
      <button
        onClick={onCycle}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm border border-border-default text-xs text-fg-muted hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)] transition-colors"
        title="Cycle (F)"
      >
        <ArrowLeftRight size={13} />
        <kbd className="font-mono text-[10px] bg-inset border border-border-default rounded px-1">F</kbd>
      </button>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Nav rail — 220px → 56px icon rail → hidden (zen)
// ───────────────────────────────────────────────────────────────────
function NavRail({
  iconOnly,
  hidden,
  peeking,
  mode,
}: {
  iconOnly: boolean;
  hidden: boolean;
  peeking: boolean;
  mode: FocusMode;
}) {
  // Width: 220 default, 56 focus, 0 zen-collapsed, 220 zen-peek (overlay).
  const width = hidden ? 0 : iconOnly ? 56 : 220;
  const overlay = mode === 'zen' && peeking;

  return (
    <aside
      className={`relative z-30 shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        overlay ? 'absolute inset-y-0 left-0 shadow-2xl' : ''
      }`}
      style={{ width }}
      aria-hidden={hidden || undefined}
    >
      <div className="p-4 border-b border-border-default flex items-center gap-2 min-w-0">
        <div className="h-6 w-6 rounded bg-accent/20 flex items-center justify-center text-accent text-xs font-bold shrink-0">
          S
        </div>
        {!iconOnly && <span className="text-sm font-semibold truncate">SAM</span>}
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {GLOBAL_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              title={iconOnly ? item.label : undefined}
              className={`flex items-center gap-3 rounded-sm border-l-2 py-2 text-sm font-medium transition-all duration-150 ${
                iconOnly ? 'justify-center px-0' : 'pl-[10px] pr-3'
              } ${
                item.active
                  ? 'text-accent border-l-accent bg-[var(--sam-chrome-accent-active-subtle)]'
                  : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)]'
              }`}
            >
              <Icon size={18} />
              {!iconOnly && <span className="truncate">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      {!iconOnly && (
        <div className="mt-auto p-3 border-t border-border-default flex items-center gap-2">
          <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-xs font-medium shrink-0">
            R
          </div>
          <span className="text-xs text-fg-muted truncate">raphael</span>
        </div>
      )}
    </aside>
  );
}

// ───────────────────────────────────────────────────────────────────
// Session panel — 288px → 64px status strip → hidden (zen)
// ───────────────────────────────────────────────────────────────────
function SessionPanel({
  strip,
  hidden,
  peeking,
  mode,
}: {
  strip: boolean;
  hidden: boolean;
  peeking: boolean;
  mode: FocusMode;
}) {
  const [query, setQuery] = useState('');
  const width = hidden ? 0 : strip ? 64 : 288;
  const overlay = mode === 'zen' && peeking;

  const filtered = MOCK_SESSIONS.filter((s) =>
    s.title.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <aside
      className={`relative z-20 shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none ${
        overlay ? 'absolute inset-y-0 left-0 shadow-2xl' : ''
      }`}
      style={{ width, left: overlay ? 56 : undefined }}
      aria-hidden={hidden || undefined}
    >
      {strip ? (
        <StatusStrip sessions={MOCK_SESSIONS} />
      ) : (
        <>
          <div className="p-3 border-b border-border-default">
            <div className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2 truncate">
              Collapsible Sidebars
            </div>
            <button className="flex items-center gap-2 w-full px-3 py-2 rounded-sm bg-[var(--sam-chrome-accent-soft)] text-accent text-sm font-medium hover:bg-[var(--sam-chrome-accent-active)] transition-colors">
              <Plus size={16} />
              New Chat
            </button>
          </div>
          <div className="px-3 py-2 border-b border-border-default">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-sm bg-inset border border-border-default">
              <Search size={13} className="text-fg-muted shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search chats…"
                className="flex-1 min-w-0 bg-transparent text-xs text-fg-primary placeholder:text-fg-muted outline-none border-none"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {filtered.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
            {filtered.length === 0 && (
              <div className="text-xs text-fg-muted text-center py-6">No chats match “{query}”.</div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function SessionRow({ session }: { session: MockSession }) {
  return (
    <button
      className={`group flex items-start gap-2 w-full px-2 py-2 rounded-sm text-left transition-colors hover:bg-[var(--sam-chrome-accent-hover-subtle)] ${
        session.stale ? 'opacity-60' : ''
      }`}
    >
      <span className={`mt-1 h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[session.status]}`} />
      <span className="flex-1 min-w-0">
        <span className="block text-xs text-fg-primary truncate group-hover:text-clip">{session.title}</span>
        <span className="block text-[10px] text-fg-muted mt-0.5">{session.when}</span>
      </span>
    </button>
  );
}

// Slim 64px strip: just colored status dots, hover to reveal title tooltip.
function StatusStrip({ sessions }: { sessions: MockSession[] }) {
  return (
    <div className="flex flex-col items-center gap-1 py-3 overflow-y-auto">
      <button
        title="New Chat"
        className="mb-2 h-9 w-9 rounded-sm bg-[var(--sam-chrome-accent-soft)] text-accent flex items-center justify-center hover:bg-[var(--sam-chrome-accent-active)] transition-colors"
      >
        <Plus size={16} />
      </button>
      {sessions.map((s) => (
        <button
          key={s.id}
          title={`${s.title} · ${s.when}`}
          className={`relative h-9 w-9 rounded-full flex items-center justify-center transition-transform hover:scale-110 ${
            s.stale ? 'opacity-50' : ''
          }`}
        >
          <span className={`h-2.5 w-2.5 rounded-full ring-2 ring-offset-2 ring-offset-transparent ${STATUS_DOT[s.status]} ${STATUS_RING[s.status]}`} />
        </button>
      ))}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Zen edge seam — a glowing strip you hover to peek a hidden panel
// ───────────────────────────────────────────────────────────────────
function EdgeSeam({
  side,
  label,
  inset,
  onEnter,
  onLeave,
}: {
  side: 'left' | 'right';
  label: string;
  inset?: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="group relative z-30 h-full w-3 shrink-0 cursor-pointer flex items-center justify-center"
      style={{ [side]: inset ? 3 : 0 }}
    >
      {/* Glow seam */}
      <span className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-0.5 rounded-full bg-[radial-gradient(ellipse_at_center,var(--sam-chrome-accent-glow)_0%,transparent_75%)] blur-[0.5px] opacity-70 group-hover:opacity-100 transition-opacity" />
      {/* Vertical label */}
      <span
        className="text-[9px] font-semibold uppercase tracking-widest text-fg-muted group-hover:text-accent transition-colors whitespace-nowrap"
        style={{ writingMode: 'vertical-rl' }}
      >
        {label}
      </span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Conversation column — mock chat content
// ───────────────────────────────────────────────────────────────────
function ConversationColumn({ mode }: { mode: FocusMode }) {
  return (
    <main className="flex-1 min-w-0 flex flex-col bg-canvas">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-border-default">
        <ChevronLeft size={16} className="text-fg-muted" />
        <span className="text-sm font-medium truncate">
          Add collapsible sidebars to the desktop UI with a coordinated focus mode toggle
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-2xl flex flex-col gap-4">
          {MOCK_CONVERSATION.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-[var(--sam-chrome-accent-active-subtle)] text-fg-primary'
                    : 'glass-chrome glass-panel-container text-fg-primary'
                }`}
              >
                {m.text}
              </div>
            </div>
          ))}

          <div className="mt-4 rounded-lg border border-dashed border-border-default p-4 text-xs text-fg-muted">
            <div className="font-semibold text-fg-primary mb-1">Reading width now: {mode === 'default' ? '~64%' : mode === 'focus' ? '~82%' : '~96%'} of the window</div>
            Current mode <span className="text-accent font-medium">{modeLabel(mode)}</span>. Press{' '}
            <kbd className="font-mono bg-inset border border-border-default rounded px-1">F</kbd> or use the
            toggle to cycle Default → Focus → Zen. In Zen, hover the glowing seams on the left edge to peek a
            panel without reflowing this column.
          </div>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border-default">
        <div className="mx-auto max-w-2xl flex items-center gap-2 px-3 py-2 rounded-lg glass-chrome glass-panel-container">
          <input
            placeholder="Message the agent…"
            className="flex-1 min-w-0 bg-transparent text-sm text-fg-primary placeholder:text-fg-muted outline-none border-none"
          />
          <button className="px-3 py-1.5 rounded-sm bg-accent text-fg-on-accent text-xs font-medium">
            Send
          </button>
        </div>
      </div>
    </main>
  );
}
