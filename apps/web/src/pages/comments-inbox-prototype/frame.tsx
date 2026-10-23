/**
 * App-shell look-alike for the prototype, following the Automation prototype's frame. The real
 * AppShell needs auth and live queries, which a dev-only prototype route must not use, so this
 * mirrors its markup and tokens: desktop glass sidebar with the project nav, phone glass header
 * plus the project bar.
 */
import {
  ArrowLeft,
  Bell,
  Brain,
  FileCode,
  FolderOpen,
  Lightbulb,
  List,
  Menu,
  MessageSquare,
  MessageSquareQuote,
  Rocket,
  Search,
  Settings,
  UserCog,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

const NAV = [
  { label: 'Chat', Icon: MessageSquare },
  { label: 'Comments', Icon: MessageSquareQuote, active: true },
  { label: 'Files', Icon: FileCode },
  { label: 'Library', Icon: FolderOpen },
  { label: 'Ideas', Icon: Lightbulb },
  { label: 'Deployments', Icon: Rocket },
  { label: 'Agent Context', Icon: Brain },
  { label: 'Notifications', Icon: Bell },
  { label: 'Automation', Icon: Workflow },
  { label: 'Profiles', Icon: UserCog },
  { label: 'Skills', Icon: Zap },
  { label: 'Settings', Icon: Settings },
];

const ITEM =
  'flex items-center gap-3 pl-[10px] pr-3 py-2 rounded-sm text-sm font-medium border-l-2 transition-all duration-150';
const ACTIVE = 'text-accent border-l-accent bg-[var(--sam-chrome-accent-active-subtle)]';
const INACTIVE = 'text-fg-muted border-l-transparent';

function Sidebar({ needsYou }: { needsYou: number }) {
  return (
    <aside className="relative z-30 flex flex-col overflow-hidden glass-panel-container glass-composited glass-chrome border-y-0 border-l-0">
      <div className="flex items-center justify-between border-0 border-b border-solid border-border-default p-4">
        <img src="/sam-head.png" alt="SAM" className="h-6 w-6 object-contain" />
        <div className="flex items-center gap-1 text-fg-muted">
          <span className="flex h-9 w-9 items-center justify-center">
            <MessageSquare size={18} aria-hidden />
          </span>
          <span className="flex h-9 w-9 items-center justify-center">
            <Bell size={18} aria-hidden />
          </span>
        </div>
      </div>
      <div className="mx-2 mt-2 flex h-9 items-center gap-2 rounded-sm border border-border-default px-3 text-[13px] text-fg-muted">
        <Search size={14} aria-hidden />
        Search…
        <kbd className="ml-auto rounded border border-border-default px-1 text-[10px]">Ctrl+K</kbd>
      </div>
      <nav
        aria-label="Project navigation (prototype)"
        className="flex flex-col gap-1 overflow-y-auto p-2"
      >
        <span className="flex items-center gap-2 px-3 py-2.5 text-sm text-fg-muted">
          <ArrowLeft size={16} aria-hidden /> Back to Projects
        </span>
        <span className="truncate px-3 py-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">
          SAM
        </span>
        {NAV.map(({ label, Icon, active }) => (
          <span
            key={label}
            className={`${ITEM} ${active ? ACTIVE : INACTIVE}`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={18} aria-hidden />
            {label}
            {active && needsYou > 0 && (
              <span
                className="ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums"
                style={{
                  background: 'var(--sam-color-warning-tint)',
                  color: 'var(--sam-color-warning-fg)',
                }}
              >
                {needsYou}
              </span>
            )}
          </span>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2 border-0 border-t border-solid border-border-default p-3 text-sm text-fg-primary">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-xs font-bold text-fg-on-accent">
          R
        </span>
        Raphaël
      </div>
    </aside>
  );
}

function MobileHeader() {
  return (
    <>
      <header className="relative z-30 flex shrink-0 items-center justify-between px-4 py-2 glass-chrome glass-panel-container glass-composited border-x-0 border-t-0">
        <img src="/sam-head.png" alt="SAM" className="h-7 w-7 object-contain" />
        <div className="flex items-center gap-1 text-fg-muted">
          {[Search, MessageSquare, Bell, Menu].map((Icon, i) => (
            <span key={i} className="flex h-9 w-9 items-center justify-center">
              <Icon size={i === 3 ? 20 : 18} aria-hidden />
            </span>
          ))}
        </div>
      </header>
      <div className="relative z-20 flex shrink-0 items-center gap-3 border-0 border-b border-solid border-border-default px-4 py-2.5 text-fg-muted">
        <Settings size={16} aria-hidden />
        <span className="flex-1 text-sm font-semibold text-fg-primary">SAM</span>
        <List size={18} aria-hidden />
      </div>
    </>
  );
}

/**
 * The scroll container is the frame's own <main> (the app does not scroll at body level).
 * `scroll={false}` hands scrolling to the page, for the desktop two-pane layout.
 */
export function AppFrame({
  children,
  wide,
  needsYou,
  scroll = true,
}: {
  children: ReactNode;
  wide: boolean;
  needsYou: number;
  scroll?: boolean;
}) {
  const mainClass = scroll
    ? 'relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden'
    : 'relative min-h-0 flex-1 overflow-hidden';
  if (!wide) {
    return (
      <div className="flex flex-col" style={{ height: '100dvh' }}>
        <MobileHeader />
        <main id="proto-scroll" className={mainClass}>
          {children}
        </main>
      </div>
    );
  }
  return (
    <div
      className="grid overflow-hidden"
      style={{ height: '100dvh', gridTemplateColumns: '232px 1fr' }}
    >
      <Sidebar needsYou={needsYou} />
      <main id="proto-scroll" className={`${mainClass} flex flex-col`}>
        {children}
      </main>
    </div>
  );
}
