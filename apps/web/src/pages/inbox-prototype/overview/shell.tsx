/**
 * PROTOTYPE ONLY — app chrome for /prototype/project-overview. Mirrors DesktopSidebar's
 * project panel (NavSidebar) and MobileAppBar, with three proposed changes: Overview is the
 * project's first nav item and its landing page, Inbox replaces Notifications in the
 * project nav, and the bell's slot opens the Inbox. The real components cannot render here
 * (they need a signed-in API, and PROJECT_NAV_ITEMS has no Overview).
 */
import {
  IconButton,
  NavItem,
  NavLabel,
  Pane,
  PaneSeparator,
  PersonAvatar,
} from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  Brain,
  FileCode,
  FolderKanban,
  FolderOpen,
  History,
  Home,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  MessageSquare,
  MessageSquareQuote,
  Rocket,
  Search,
  Server,
  Settings,
  UserCog,
  Workflow,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { PROJECT_NAME } from './data';

export type NavTarget = 'overview' | 'chat' | 'inbox' | 'all-inbox';

function InboxBell({
  count,
  active,
  onClick,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
}) {
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
      data-testid="inbox-bell"
    />
  );
}

/** Desktop sidebar: inside a project, or on the cross-project Inbox (global nav). */
export function Sidebar({
  current,
  badge,
  projectCount,
  bellOpen,
  onBell,
  onNav,
}: {
  current: NavTarget;
  /** Cross-project open asks you can act on (the bell). */
  badge: number;
  /** This project's open asks (the Inbox nav item). */
  projectCount: number;
  bellOpen: boolean;
  onBell: () => void;
  onNav: (to: NavTarget) => void;
}) {
  const global = current === 'all-inbox';
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
          <InboxBell count={badge} active={bellOpen || global} onClick={onBell} />
        </div>
      </div>
      <div className="shrink-0 px-3 pb-1">
        <div className="sam-well flex h-10 items-center gap-2.5 rounded-[var(--sam-radius-control)] px-3 text-sm text-fg-muted">
          <Search size={16} aria-hidden="true" /> Search...
        </div>
      </div>
      {global ? (
        <nav
          aria-label="Primary navigation"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2"
        >
          <NavItem label="Home" icon={<Home size={18} />} onClick={() => {}} />
          <NavItem
            label="Inbox"
            icon={<Inbox size={18} />}
            current
            count={badge}
            countTone="attention"
            onClick={() => {}}
          />
          <NavItem label="Chats" icon={<MessageSquare size={18} />} onClick={() => {}} />
          <NavItem
            label="Projects"
            icon={<FolderKanban size={18} />}
            onClick={() => onNav('overview')}
          />
          <NavItem label="Infrastructure" icon={<Server size={18} />} onClick={() => {}} />
          <NavItem label="Settings" icon={<Settings size={18} />} onClick={() => {}} />
        </nav>
      ) : (
        <nav
          aria-label="Project navigation"
          className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2"
        >
          <button
            type="button"
            className="flex h-10 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[11px] border-none bg-transparent px-3 text-[14.5px] text-fg-muted"
          >
            <ArrowLeft size={16} /> Back to Projects
          </button>
          <NavLabel>{PROJECT_NAME}</NavLabel>
          <NavItem
            label="Overview"
            icon={<LayoutDashboard size={18} />}
            current={current === 'overview'}
            onClick={() => onNav('overview')}
          />
          <NavItem
            label="Chat"
            icon={<MessageSquare size={18} />}
            current={current === 'chat'}
            onClick={() => onNav('chat')}
          />
          <NavItem
            label="Inbox"
            icon={<Inbox size={18} />}
            current={current === 'inbox'}
            count={projectCount || undefined}
            countTone="attention"
            onClick={() => onNav('inbox')}
          />
          <NavItem label="Ideas" icon={<Lightbulb size={18} />} onClick={() => {}} />
          <NavItem label="Library" icon={<FolderOpen size={18} />} onClick={() => {}} />
          <NavItem label="Files" icon={<FileCode size={18} />} onClick={() => {}} />
          <NavItem label="Comments" icon={<MessageSquareQuote size={18} />} onClick={() => {}} />
          <NavItem label="Automation" icon={<Workflow size={18} />} onClick={() => {}} />
          <NavItem label="Deployments" icon={<Rocket size={18} />} onClick={() => {}} />
          <NavItem label="Profiles" icon={<UserCog size={18} />} onClick={() => {}} />
          <NavItem label="Skills" icon={<Zap size={18} />} onClick={() => {}} />
          <NavItem label="Agent Context" icon={<Brain size={18} />} onClick={() => {}} />
          <NavItem label="Settings" icon={<Settings size={18} />} onClick={() => {}} />
        </nav>
      )}
      <PaneSeparator className="mx-3" />
      <div className="flex items-center gap-2.5 px-3 pt-2 pb-3">
        <PersonAvatar name="Raphaël" person="you" size={26} />
        <span className="text-[13.5px] font-medium text-fg-primary">Raphaël</span>
      </div>
    </Pane>
  );
}

/**
 * The phone app bar, as MobileAppBar: menu (or back), the title, Recent chats + Inbox in a
 * well, and the screen's main action raised at the right edge. On the Overview that action
 * is Chat, so chat stays one tap from the landing page.
 */
export function PhoneBar({
  title,
  badge,
  onBell,
  bellActive = false,
  left,
  action,
}: {
  title: string;
  badge: number;
  onBell: () => void;
  bellActive?: boolean;
  left?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Pane
      as="header"
      variant="slab"
      className="relative z-30 flex h-14 shrink-0 items-center gap-1 pr-1.5 pl-1"
    >
      {left ?? <IconButton label="Open navigation menu" icon={<MenuIcon />} showTooltip={false} />}
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
        <InboxBell count={badge} active={bellActive} onClick={onBell} />
      </div>
      {action}
    </Pane>
  );
}

function MenuIcon() {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconButton
      label={label}
      icon={<ArrowLeft size={20} />}
      onClick={onClick}
      showTooltip={false}
    />
  );
}

/** Chat, raised at the app bar's right edge: the Overview's one-tap way into chat. */
export function ChatAction({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      raised
      label="Open chat"
      icon={<MessageSquare size={20} strokeWidth={1.75} />}
      onClick={onClick}
      showTooltip={false}
      className="ml-1"
      data-testid="open-chat"
    />
  );
}
