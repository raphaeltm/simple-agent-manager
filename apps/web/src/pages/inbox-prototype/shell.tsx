/**
 * PROTOTYPE ONLY — the app chrome for /prototype/inbox, mirroring MobileAppBar and
 * DesktopSidebar with the bell's slot taken by the Inbox (no new nav item). The real
 * components embed NotificationCenter and RecentChatsDropdown, which need a signed-in API.
 */
import { IconButton, NavItem, Pane, PaneSeparator, PersonAvatar } from '@simple-agent-manager/ui';
import {
  FolderKanban,
  History,
  Inbox,
  LayoutDashboard,
  Library,
  Lightbulb,
  Menu,
  MessagesSquare,
  Search,
  Settings,
} from 'lucide-react';
import type { ReactNode } from 'react';

export interface InboxButtonProps {
  count: number;
  active: boolean;
  onClick: () => void;
}

function InboxButton({ count, active, onClick }: InboxButtonProps) {
  return (
    <IconButton
      label={`Inbox${count ? `, ${count} need you` : ''}`}
      icon={<Inbox size={20} strokeWidth={1.75} />}
      count={count > 99 ? '99+' : count || undefined}
      countTone="attention"
      raised={active}
      aria-pressed={active}
      onClick={onClick}
      showTooltip={false}
    />
  );
}

/** The single phone app bar. `left` replaces the menu button (e.g. a back arrow). */
export function MobileBar({
  title,
  inbox,
  left,
  right,
}: {
  title: string;
  inbox: InboxButtonProps;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Pane
      as="header"
      variant="slab"
      className="relative z-30 flex h-14 shrink-0 items-center gap-1 pr-1.5 pl-1"
    >
      {left ?? (
        <IconButton
          label="Open navigation menu"
          icon={<Menu size={22} strokeWidth={1.75} />}
          showTooltip={false}
        />
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <img src="/sam-head.png" alt="" className="h-7 w-7 shrink-0 object-contain" />
        <span className="min-w-0 truncate text-[17px] font-semibold text-fg-primary">{title}</span>
      </span>
      <div className="sam-well flex shrink-0 items-center rounded-[14px] p-0.5">
        <IconButton
          label="Recent chats"
          icon={<History size={20} strokeWidth={1.75} />}
          showTooltip={false}
        />
        <InboxButton {...inbox} />
      </div>
      {right}
    </Pane>
  );
}

export function DesktopSidebar({
  inbox,
  current,
}: {
  inbox: InboxButtonProps;
  current?: 'chats' | 'projects';
}) {
  return (
    <Pane className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
      <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-2">
        <img src="/sam-head.png" alt="SAM" className="h-8 w-8 object-contain" />
        <div className="flex items-center">
          <IconButton
            label="Recent chats"
            icon={<History size={20} strokeWidth={1.75} />}
            showTooltip={false}
          />
          <InboxButton {...inbox} />
        </div>
      </div>
      <div className="shrink-0 px-3 pb-1">
        <div className="sam-well flex h-10 items-center gap-2.5 rounded-[var(--sam-radius-control)] px-3 text-sm text-fg-muted">
          <Search size={16} aria-hidden="true" /> Search...
        </div>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 px-2 pt-2">
        <NavItem label="Dashboard" icon={<LayoutDashboard size={18} />} onClick={() => {}} />
        <NavItem
          label="Chats"
          icon={<MessagesSquare size={18} />}
          onClick={() => {}}
          current={current === 'chats'}
        />
        <NavItem
          label="Projects"
          icon={<FolderKanban size={18} />}
          onClick={() => {}}
          current={current === 'projects'}
        />
        <NavItem label="Ideas" icon={<Lightbulb size={18} />} onClick={() => {}} />
        <NavItem label="Library" icon={<Library size={18} />} onClick={() => {}} />
        <NavItem label="Settings" icon={<Settings size={18} />} onClick={() => {}} />
      </nav>
      <PaneSeparator className="mx-3" />
      <div className="flex items-center gap-2.5 px-3 pt-2 pb-3">
        <PersonAvatar name="Raphaël" person="you" size={26} />
        <span className="text-sm text-fg-primary">Raphaël</span>
      </div>
    </Pane>
  );
}

/** Viewport-height scroll container (the app does not scroll at html/body) + the void. */
export function Frame({ mobile, children }: { mobile: boolean; children: ReactNode }) {
  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <div
        className={`sam-void grid h-screen min-h-0 gap-[var(--sam-space-gutter)] ${
          mobile
            ? 'grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] p-2'
            : 'grid-cols-[248px_minmax(0,1fr)] p-4'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/** A plausible project chat to sit under Direction C's sheet. */
export function ChatBackdrop() {
  const lines: [string, string][] = [
    ['you', 'Ship the Stripe billing flow this week. Live mode, EU customers first.'],
    [
      'agent',
      'Checkout, webhooks and the plans table are merged on staging. Running the full test suite now.',
    ],
    [
      'agent',
      '412 tests passed. Writing the trial logic for Starter while I wait on two decisions.',
    ],
    ['you', 'Sounds good. I will answer from my phone.'],
  ];
  return (
    <Pane variant="quiet" className="flex min-h-0 flex-col rounded-[var(--sam-radius-pane)]">
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-hidden p-4">
        {lines.map(([who, text], i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] ${
              who === 'you' ? 'sam-raised self-end text-fg-primary' : 'self-start text-fg-secondary'
            }`}
          >
            {text}
          </div>
        ))}
      </div>
      <div className="p-3">
        <div className="sam-well flex h-12 items-center rounded-[var(--sam-radius-slab)] px-4 text-[15px] text-fg-muted">
          Message the agent…
        </div>
      </div>
    </Pane>
  );
}
