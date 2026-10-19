/**
 * PROTOTYPE ONLY — app chrome for the Workflows exploration.
 *
 * AppShell and NavSidebar need auth, onboarding and API state, so this copies
 * their markup and class strings (AppShell.tsx desktop aside, NavSidebar.tsx
 * project panel) and swaps in the per-option nav items. On phones it renders
 * the REAL MobileNavDrawer. The amber strip at the top marks every screen as a
 * prototype.
 */
import {
  ArrowLeft,
  Bell,
  Brain,
  Clock,
  FileCode,
  FlaskConical,
  FolderKanban,
  FolderOpen,
  Home,
  Lightbulb,
  Map as MapIcon,
  Menu,
  MessageSquare,
  MessageSquareQuote,
  Radio,
  Rocket,
  Search,
  Settings,
  UserCog,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { MobileNavDrawer, type MobileNavItem } from '../../components/MobileNavDrawer';
import { useIsMobile } from '../../hooks/useIsMobile';
import { RUNS } from './mock-workflows';
import { OWNER, PROJECT } from './mock-world';
import { frameAt } from './model';

/** Same rule as the Runs tab's "Needs you" section. */
export const NEEDS_YOU_COUNT = RUNS.filter((r) =>
  ['needs_you', 'needs_attention'].includes(frameAt(r, null).status)
).length;

export type IaOption = 'A' | 'B' | 'C';
export const BASE = '/prototype/workflows';
export const p = (path: string) => `${BASE}/${path}`;

interface NavDef {
  key: string;
  label: string;
  icon: ReactNode;
  to?: string;
  badge?: number;
}

/** Real GLOBAL_NAV_ITEMS (NavSidebar.tsx), used when not inside a project. */
function globalItems(): NavDef[] {
  return [
    { key: 'home', label: 'Home', icon: <Home size={18} />, to: p('c/home') },
    { key: 'chats', label: 'Chats', icon: <MessageSquare size={18} /> },
    { key: 'projects', label: 'Projects', icon: <FolderKanban size={18} /> },
    { key: 'map', label: 'Map', icon: <MapIcon size={18} /> },
    { key: 'tools', label: 'Tools', icon: <Wrench size={18} /> },
    { key: 'settings', label: 'Settings', icon: <Settings size={18} /> },
  ];
}

function navItems(option: IaOption): NavDef[] {
  const chatTo = option === 'A' ? p('a/chat') : option === 'C' ? p('c/run') : p('b/chat');
  const items: NavDef[] = [
    { key: 'chat', label: 'Chat', icon: <MessageSquare size={18} />, to: chatTo },
    { key: 'comments', label: 'Comments', icon: <MessageSquareQuote size={18} /> },
    { key: 'files', label: 'Files', icon: <FileCode size={18} /> },
    {
      key: 'library',
      label: 'Library',
      icon: <FolderOpen size={18} />,
      to: option === 'C' ? p('c/runbook') : undefined,
    },
    {
      key: 'ideas',
      label: 'Ideas',
      icon: <Lightbulb size={18} />,
      to: option === 'A' ? p('a/plans') : undefined,
    },
    { key: 'deployments', label: 'Deployments', icon: <Rocket size={18} /> },
    { key: 'agent-context', label: 'Agent Context', icon: <Brain size={18} /> },
    { key: 'notifications', label: 'Notifications', icon: <Bell size={18} /> },
    { key: 'events', label: 'Events', icon: <Radio size={18} /> },
    { key: 'triggers', label: 'Triggers', icon: <Clock size={18} /> },
    { key: 'profiles', label: 'Profiles', icon: <UserCog size={18} /> },
    { key: 'skills', label: 'Skills', icon: <Zap size={18} /> },
    { key: 'settings', label: 'Settings', icon: <Settings size={18} /> },
  ];
  if (option === 'B') {
    // Option B's only navigation change: one project item, right under Chat.
    items.splice(1, 0, {
      key: 'workflows',
      label: 'Workflows',
      icon: <Workflow size={18} />,
      to: p('b/workflows'),
      badge: NEEDS_YOU_COUNT,
    });
  }
  return items;
}

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const NAV_ITEM_BASE = `shrink-0 flex items-center gap-3 pl-[10px] pr-3 py-2 rounded-sm no-underline text-sm font-medium border-l-2 transition-all duration-150 ${FOCUS_RING}`;
const NAV_ITEM_ACTIVE = 'text-accent border-l-accent bg-[var(--sam-chrome-accent-active-subtle)]';
const NAV_ITEM_INACTIVE =
  'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-[var(--sam-chrome-accent-hover-subtle)]';

function NavBadge({ n }: { n: number }) {
  return (
    <span
      className="ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-none"
      style={{ background: 'var(--sam-color-warning)', color: '#1a1205' }}
      aria-label={`${n} waiting for you`}
    >
      {n}
    </span>
  );
}

export function PrototypeStrip({ label, extra }: { label: string; extra?: ReactNode }) {
  return (
    <div
      className="shrink-0 flex items-center gap-2 px-3 text-[11px] font-medium"
      style={{
        height: 26,
        background: 'var(--sam-color-warning-tint)',
        borderBottom: '1px solid color-mix(in srgb, var(--sam-color-warning) 35%, transparent)',
        color: 'var(--sam-color-warning-fg)',
      }}
      role="note"
    >
      <FlaskConical size={12} aria-hidden />
      <span className="font-bold tracking-wide">PROTOTYPE</span>
      <span className="truncate opacity-90">{label} · synthetic data · not connected to SAM</span>
      <span className="ml-auto shrink-0 flex items-center gap-3">
        {extra}
        <Link to={BASE} className="shrink-0 underline" style={{ color: 'inherit' }}>
          All screens
        </Link>
      </span>
    </div>
  );
}

function BellButton({ count }: { count: number }) {
  return (
    <button
      type="button"
      aria-label={`Notifications (${count} need attention)`}
      className="relative flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer hover:text-fg-primary"
    >
      <Bell size={18} />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-fg-on-accent text-[10px] font-bold leading-none">
          {count}
        </span>
      )}
    </button>
  );
}

export function ProtoShell({
  option,
  active,
  label,
  children,
  bellCount = NEEDS_YOU_COUNT,
  stripExtra,
  scope = 'project',
}: {
  option: IaOption;
  active: string;
  label: string;
  children: ReactNode;
  bellCount?: number;
  scope?: 'project' | 'global';
  /** Prototype-only controls shown in the strip, never over the app UI. */
  stripExtra?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const items = scope === 'global' ? globalItems() : navItems(option);

  if (isMobile) {
    const mobileItems: MobileNavItem[] = items.map((i) => ({
      label: i.badge ? `${i.label} (${i.badge})` : i.label,
      path: i.to ?? `${location.pathname}#${i.key}`,
      icon: i.icon,
    }));
    return (
      <div className="flex flex-col h-full">
        <PrototypeStrip label={label} extra={stripExtra} />
        <header className="relative z-30 flex items-center justify-between px-4 py-2 glass-chrome glass-panel-container glass-composited border-x-0 border-t-0">
          <img src="/sam-head.png" alt="SAM" className="h-7 w-7 object-contain" />
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Open command palette"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted"
            >
              <Search size={18} />
            </button>
            <button
              type="button"
              aria-label="Recent chats"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted"
            >
              <MessageSquare size={18} />
            </button>
            <BellButton count={bellCount} />
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation menu"
              className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted cursor-pointer"
            >
              <Menu size={20} />
            </button>
          </div>
        </header>
        <main
          id="main-content"
          className="sam-main-content flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col min-w-0"
        >
          {children}
        </main>
        {drawerOpen && (
          <MobileNavDrawer
            onClose={() => setDrawerOpen(false)}
            user={{ name: OWNER.name, email: 'priya@northwindlabs.dev' }}
            navItems={mobileItems}
            currentPath={items.find((i) => i.key === active)?.to ?? location.pathname}
            onNavigate={(path) => {
              setDrawerOpen(false);
              if (!path.includes('#')) navigate(path);
            }}
            onSignOut={() => setDrawerOpen(false)}
            projectName={scope === 'project' ? PROJECT.name : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PrototypeStrip label={label} extra={stripExtra} />
      <div
        className="grid flex-1 min-h-0 overflow-hidden"
        style={{ gridTemplateColumns: '220px 1fr' }}
      >
        <aside className="relative z-30 glass-panel-container glass-composited flex flex-col glass-chrome border-y-0 border-l-0 overflow-y-auto overflow-x-hidden">
          <div className="p-4 border-b border-border-default flex items-center justify-between">
            <img src="/sam-head.png" alt="SAM" className="h-6 w-6 object-contain" />
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Recent chats"
                className="flex items-center justify-center w-9 h-9 bg-transparent border-none text-fg-muted"
              >
                <MessageSquare size={18} />
              </button>
              <BellButton count={bellCount} />
            </div>
          </div>
          <button
            type="button"
            className="mx-2 mt-2 flex items-center gap-2 px-3 py-1.5 rounded-sm bg-transparent border border-border-default text-fg-muted text-xs"
            aria-label="Open command palette"
          >
            <Search size={12} />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="font-mono text-[10px] bg-inset border border-border-default rounded px-1 py-0.5">
              Ctrl+K
            </kbd>
          </button>
          <nav
            aria-label="Project navigation"
            className="flex flex-col gap-1 p-2 flex-1 min-h-0 overflow-y-auto"
          >
            {scope === 'project' && (
              <>
                <span className="shrink-0 flex items-center gap-2 px-3 py-2.5 text-sm text-fg-muted">
                  <ArrowLeft size={16} />
                  <span>Back to Projects</span>
                </span>
                <div className="shrink-0 px-3 py-2 text-xs font-semibold text-fg-muted uppercase tracking-wider truncate">
                  {PROJECT.name}
                </div>
              </>
            )}
            {items.map((item) => {
              const isActive = item.key === active;
              const cls = `${NAV_ITEM_BASE} ${isActive ? NAV_ITEM_ACTIVE : NAV_ITEM_INACTIVE}`;
              const body = (
                <>
                  {item.icon}
                  {item.label}
                  {item.badge ? <NavBadge n={item.badge} /> : null}
                </>
              );
              return item.to ? (
                <Link
                  key={item.key}
                  to={item.to}
                  aria-current={isActive ? 'page' : undefined}
                  className={cls}
                >
                  {body}
                </Link>
              ) : (
                <span
                  key={item.key}
                  className={`${cls} cursor-default`}
                  title="Not part of this prototype"
                >
                  {body}
                </span>
              );
            })}
          </nav>
          <div className="border-t border-[var(--sam-glass-border-color)] bg-[var(--sam-chrome-footer-bg)]">
            <div className="p-3 flex items-center gap-2">
              <div className="h-7 w-7 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-xs font-medium">
                P
              </div>
              <div className="flex-1 min-w-0 text-xs font-medium text-fg-primary truncate">
                {OWNER.name}
              </div>
            </div>
          </div>
        </aside>
        <main
          id="main-content"
          className="sam-main-content flex-1 overflow-y-auto overflow-x-hidden flex flex-col min-w-0"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/** Same page wrapper the real Project shell gives non-chat project pages. */
export function ProjectPage({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  return (
    <div
      className="max-w-[80rem] w-full mx-auto min-w-0"
      style={
        isMobile
          ? { padding: 'var(--sam-space-3) var(--sam-space-3) var(--sam-space-8)' }
          : { padding: 'var(--sam-space-8) clamp(var(--sam-space-3), 3vw, var(--sam-space-4))' }
      }
    >
      <div className="flex flex-col min-w-0 [&>*]:max-w-full">{children}</div>
    </div>
  );
}
