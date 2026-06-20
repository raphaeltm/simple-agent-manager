import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronLeft,
  CirclePause,
  HelpCircle,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { GLOBAL_NAV_ITEMS } from '../../components/NavSidebar';
import type { ChatSessionListItem, ChatSessionResponse } from '../../lib/api';
import { type AttentionState, getAttentionState } from '../../lib/chat-session-utils';
import { SessionList } from '../project-chat/SessionList';
import { SessionTreeItem } from '../project-chat/SessionTreeItem';
import { MOCK_CONVERSATION, MOCK_SESSIONS, MOCK_TASK_INFO } from './mock-data';

/**
 * Sidebar Collapse Prototype — Focus Mode
 *
 * Throwaway design exploration (see .claude/rules/37-prototype-development.md).
 * Demonstrates a coordinated three-state "Focus Mode" toggle that collapses
 * BOTH desktop sidebars (main nav + project chat sessions) together:
 *
 *   Default → full 220px nav rail + 288px session list (today's layout)
 *   Focus   → 56px icon rail nav + slim status strip using the REAL chat-card
 *             status icons; hover an icon to peek the full real card
 *   Zen     → both tucked to glowing edge seams; hover a seam to peek
 *
 * Uses the production SessionList / SessionItem components with mock data shaped
 * to the real ChatSessionListItem + TaskInfo types. Self-contained: no API
 * calls, no auth.
 */

type FocusMode = 'default' | 'focus' | 'zen';

const MODE_ORDER: FocusMode[] = ['default', 'focus', 'zen'];

const noop = () => {};

/**
 * Mirror of ATTENTION_ICON_MAP in project-chat/SessionItem.tsx so the Focus
 * strip uses the exact same icons + colors as the real chat cards.
 */
const ATTENTION_ICON: Record<AttentionState, { icon: typeof HelpCircle; color: string; label: string }> = {
  needs_input: { icon: HelpCircle, color: 'var(--sam-color-warning, #f59e0b)', label: 'Needs input' },
  error: { icon: AlertCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Error' },
  active: { icon: Loader2, color: 'var(--sam-color-success)', label: 'Running' },
  idle: { icon: CirclePause, color: 'var(--sam-color-warning, #f59e0b)', label: 'Idle' },
  completed: { icon: CheckCircle2, color: 'var(--sam-color-fg-muted)', label: 'Completed' },
  failed: { icon: XCircle, color: 'var(--sam-color-danger, #ef4444)', label: 'Failed' },
  stopped: { icon: CirclePause, color: 'var(--sam-color-fg-muted)', label: 'Stopped' },
};

/** Enrich a list item with its task embed (mirrors SessionTreeItem) so the
 * attention-state helpers can distinguish completed/failed/cancelled tasks. */
function enrich(session: ChatSessionListItem): ChatSessionResponse {
  const info = session.taskId ? MOCK_TASK_INFO.get(session.taskId) : undefined;
  if (!info) return session;
  return { ...session, task: { id: info.id, status: info.status, taskMode: info.taskMode } };
}

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
  const [selectedSessionId, setSelectedSessionId] = useState<string>('s1');

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

  const navIconOnly = mode === 'focus';
  const sessionsStrip = mode === 'focus';

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
        {mode !== 'zen' ? (
          <>
            <NavAside iconOnly={navIconOnly} />
            <SessionAside
              strip={sessionsStrip}
              selectedSessionId={selectedSessionId}
              onSelect={setSelectedSessionId}
            />
          </>
        ) : (
          <>
            <ZenPeekRail label="Navigation" seamAlign="top" panelWidth={220}>
              <NavRailContent iconOnly={false} />
            </ZenPeekRail>
            <ZenPeekRail label="Chats" seamAlign="bottom" panelWidth={288}>
              <SessionPanelContent
                selectedSessionId={selectedSessionId}
                onSelect={setSelectedSessionId}
              />
            </ZenPeekRail>
          </>
        )}

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
// Nav rail — 220px → 56px icon rail. Uses the real GLOBAL_NAV_ITEMS.
// ───────────────────────────────────────────────────────────────────
function NavAside({ iconOnly }: { iconOnly: boolean }) {
  return (
    <aside
      className="relative z-30 shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{ width: iconOnly ? 56 : 220 }}
    >
      <NavRailContent iconOnly={iconOnly} />
    </aside>
  );
}

function NavRailContent({ iconOnly }: { iconOnly: boolean }) {
  return (
    <>
      <div className="p-4 border-b border-border-default flex items-center gap-2 min-w-0">
        <div className="h-6 w-6 rounded bg-accent/20 flex items-center justify-center text-accent text-xs font-bold shrink-0">
          S
        </div>
        {!iconOnly && <span className="text-sm font-semibold truncate">SAM</span>}
      </div>

      <nav className="flex flex-col gap-1 p-2">
        {GLOBAL_NAV_ITEMS.map((item) => {
          const active = item.path === '/projects';
          return (
            <div
              key={item.label}
              title={iconOnly ? item.label : undefined}
              className={`flex items-center gap-3 rounded-sm border-l-2 py-2 text-sm font-medium transition-all duration-150 cursor-pointer ${
                iconOnly ? 'justify-center px-0' : 'pl-[10px] pr-3'
              } ${
                active
                  ? 'text-accent border-l-accent bg-[var(--sam-chrome-accent-active-subtle)]'
                  : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)]'
              }`}
            >
              {item.icon}
              {!iconOnly && <span className="truncate">{item.label}</span>}
            </div>
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
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Session panel — full 288px list (real SessionList) → 64px focus strip
// ───────────────────────────────────────────────────────────────────
function SessionAside({
  strip,
  selectedSessionId,
  onSelect,
}: {
  strip: boolean;
  selectedSessionId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      className="relative z-30 shrink-0 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 flex flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={{ width: strip ? 64 : 288 }}
    >
      {strip ? (
        <FocusStrip selectedSessionId={selectedSessionId} onSelect={onSelect} />
      ) : (
        <SessionPanelContent selectedSessionId={selectedSessionId} onSelect={onSelect} />
      )}
    </aside>
  );
}

/** Full session list using the production SessionList component. */
function SessionPanelContent({
  selectedSessionId,
  onSelect,
}: {
  selectedSessionId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = MOCK_SESSIONS.filter((s) =>
    (s.topic ?? '').toLowerCase().includes(query.toLowerCase()),
  );

  return (
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
      <div className="flex-1 overflow-y-auto">
        <SessionList
          sessions={filtered}
          selectedSessionId={selectedSessionId}
          onSelect={onSelect}
          taskInfoMap={MOCK_TASK_INFO}
          onShowHierarchy={noop}
        />
        {filtered.length === 0 && (
          <div className="text-xs text-fg-muted text-center py-6">No chats match “{query}”.</div>
        )}
      </div>
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
// Focus strip — 64px rail of REAL chat-card status icons; hover an icon
// to peek the full real chat card as a tooltip.
// ───────────────────────────────────────────────────────────────────
function FocusStrip({
  selectedSessionId,
  onSelect,
}: {
  selectedSessionId: string;
  onSelect: (id: string) => void;
}) {
  // The tooltip is rendered via a portal to <body> with FIXED positioning
  // computed from the hovered icon's bounding rect. A CSS-only `group-hover`
  // tooltip has to escape several `transform` (glass-composited) and
  // `contain: paint` (glass-panel-container) ancestors, which silently clip or
  // mis-stack it. A body portal sidesteps every clipping/stacking ancestor.
  const [hovered, setHovered] = useState<{
    session: ChatSessionListItem;
    top: number;
    left: number;
  } | null>(null);

  return (
    <div className="flex flex-col items-center gap-1 py-3">
      <button
        title="New Chat"
        className="mb-2 h-9 w-9 rounded-sm bg-[var(--sam-chrome-accent-soft)] text-accent flex items-center justify-center hover:bg-[var(--sam-chrome-accent-active)] transition-colors"
      >
        <Plus size={16} />
      </button>
      {MOCK_SESSIONS.map((session) => {
        const enriched = enrich(session);
        const attention = getAttentionState(enriched);
        const cfg = ATTENTION_ICON[attention];
        const Icon = cfg.icon;
        const isSelected = session.id === selectedSessionId;
        const showCard = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          setHovered({ session, top: r.top, left: r.right + 8 });
        };
        return (
          <div key={session.id} className="w-full flex justify-center">
            <button
              type="button"
              onClick={() => onSelect(session.id)}
              onMouseEnter={(e) => showCard(e.currentTarget)}
              onMouseLeave={() => setHovered(null)}
              onFocus={(e) => showCard(e.currentTarget)}
              onBlur={() => setHovered(null)}
              title={cfg.label}
              aria-label={`${session.topic ?? session.id} — ${cfg.label}`}
              className={`h-9 w-9 rounded-full flex items-center justify-center transition-colors ${
                isSelected
                  ? 'bg-[var(--sam-chrome-accent-active-subtle)]'
                  : 'hover:bg-[var(--sam-chrome-accent-hover-subtle)]'
              }`}
              style={{ color: cfg.color }}
            >
              <Icon size={16} className={attention === 'active' ? 'motion-safe:animate-spin' : ''} />
            </button>
          </div>
        );
      })}

      {hovered &&
        createPortal(
          <div
            data-testid="focus-tooltip"
            className="pointer-events-none fixed z-[100] w-72"
            style={{ top: hovered.top, left: hovered.left }}
          >
            <div className="glass-chrome glass-panel-container glass-composited rounded-md border border-border-default shadow-2xl overflow-hidden">
              <SessionTreeItem
                session={hovered.session}
                selectedSessionId={selectedSessionId}
                onSelect={noop}
                taskInfoMap={MOCK_TASK_INFO}
                onShowHierarchy={noop}
              />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Zen edge seam + peek overlay.
//
// The two seams are stacked VERTICALLY at the same left edge (Navigation =
// top half, Chats = bottom half) rather than side-by-side. Side-by-side seams
// caused a hover trap: moving the cursor from one seam rightward into its peek
// panel crossed the *other* seam, which opened the wrong panel and covered the
// one you wanted. Stacked, the path from a seam into its panel moves rightward
// and never crosses the other seam (which lives in the other vertical band).
//
// The peek panel is a DOM CHILD of the hover wrapper, so moving the mouse from
// the seam onto the panel does NOT fire mouseleave — eliminating the
// open/close flicker loop. The wrapper is only a half-height seam band; the
// panel uses height:200% to span the full viewport column.
// ───────────────────────────────────────────────────────────────────
function ZenPeekRail({
  label,
  seamAlign,
  panelWidth,
  children,
}: {
  label: string;
  seamAlign: 'top' | 'bottom';
  panelWidth: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const top = seamAlign === 'top';
  return (
    <div
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className={`group absolute left-0 h-1/2 w-3 z-40 ${top ? 'top-0' : 'bottom-0'}`}
    >
      {/* Seam visual — fills this half-height band, the hover target */}
      <div className="relative h-full w-full cursor-pointer flex items-center justify-center">
        <span className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-0.5 rounded-full bg-[radial-gradient(ellipse_at_center,var(--sam-chrome-accent-glow)_0%,transparent_75%)] blur-[0.5px] opacity-70 group-hover:opacity-100 transition-opacity" />
        <span
          className="text-[9px] font-semibold uppercase tracking-widest text-fg-muted group-hover:text-accent transition-colors whitespace-nowrap"
          style={{ writingMode: 'vertical-rl' }}
        >
          {label}
        </span>
      </div>

      {/* Peek panel — child of the hover wrapper (no flicker). height:200% of
          the half-height band = full viewport column. */}
      {open && (
        <aside
          className={`absolute left-3 glass-chrome glass-panel-container glass-composited border-y-0 border-l-0 shadow-2xl flex flex-col overflow-hidden ${
            top ? 'top-0' : 'bottom-0'
          }`}
          style={{ width: panelWidth, height: '200%' }}
        >
          {children}
        </aside>
      )}
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
            <div className="font-semibold text-fg-primary mb-1">
              Reading width now: {mode === 'default' ? '~64%' : mode === 'focus' ? '~82%' : '~96%'} of the window
            </div>
            Current mode <span className="text-accent font-medium">{modeLabel(mode)}</span>. Press{' '}
            <kbd className="font-mono bg-inset border border-border-default rounded px-1">F</kbd> or use the
            toggle to cycle Default → Focus → Zen. In Focus, hover a status icon to see the full real chat
            card. In Zen, hover the glowing seams on the left edge to peek a panel without reflowing this
            column.
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
