import {
  Activity,
  Bell,
  Brain,
  Clock,
  FolderKanban,
  FolderOpen,
  Home,
  Lightbulb,
  Map,
  MessageSquare,
  Settings,
  UserCog,
  Wrench,
  Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';

export interface MockNavItem {
  label: string;
  icon: ComponentType<{ size?: number }>;
  active?: boolean;
}

/** Global nav items — mirrors GLOBAL_NAV_ITEMS in the real NavSidebar. */
export const GLOBAL_NAV: MockNavItem[] = [
  { label: 'Home', icon: Home },
  { label: 'Chats', icon: MessageSquare },
  { label: 'Projects', icon: FolderKanban, active: true },
  { label: 'Map', icon: Map },
  { label: 'Tools', icon: Wrench },
  { label: 'Settings', icon: Settings },
];

/** Project sub-nav — mirrors PROJECT_NAV_ITEMS in the real NavSidebar. */
export const PROJECT_NAV: MockNavItem[] = [
  { label: 'Chat', icon: MessageSquare, active: true },
  { label: 'Library', icon: FolderOpen },
  { label: 'Ideas', icon: Lightbulb },
  { label: 'Agent Context', icon: Brain },
  { label: 'Notifications', icon: Bell },
  { label: 'Triggers', icon: Clock },
  { label: 'Profiles', icon: UserCog },
  { label: 'Skills', icon: Zap },
  { label: 'Activity', icon: Activity },
  { label: 'Settings', icon: Settings },
];

export type SessionStatus = 'running' | 'done' | 'failed' | 'idle';

export interface MockSession {
  id: string;
  title: string;
  status: SessionStatus;
  /** Relative time label, e.g. "2m". */
  when: string;
  stale?: boolean;
}

/** Stress-test session list: long titles, every status, many items, an empty-ish edge. */
export const MOCK_SESSIONS: MockSession[] = [
  { id: 's1', title: 'Add collapsible sidebars to the desktop UI with a coordinated focus mode toggle', status: 'running', when: 'now' },
  { id: 's2', title: 'Fix the agent status bar staying alive during long tool calls', status: 'running', when: '4m' },
  { id: 's3', title: 'Investigate disappearing messages regression', status: 'failed', when: '12m' },
  { id: 's4', title: 'Refactor SessionList virtualization', status: 'done', when: '31m' },
  { id: 's5', title: 'Q', status: 'done', when: '44m' },
  { id: 's6', title: 'Wire up the new chat starter prompts grid', status: 'idle', when: '1h' },
  { id: 's7', title: 'Audit warm-pool node lifecycle alarms and cron sweep interaction', status: 'done', when: '2h' },
  { id: 's8', title: 'Bump default Workers AI model to Gemma 4 26B', status: 'done', when: '3h' },
  { id: 's9', title: 'Trace credential snapshot resilience for raw hetzner tokens', status: 'failed', when: '5h' },
  { id: 's10', title: 'Polish the glass chrome accent glow on mobile header', status: 'done', when: '6h' },
  { id: 's11', title: 'Older exploratory spike on inline session dropdown', status: 'idle', when: '1d', stale: true },
  { id: 's12', title: 'Archived: original 1-env-per-node provisioning notes', status: 'done', when: '2d', stale: true },
  { id: 's13', title: 'Archived chat about email triggers via Cloudflare Email Workers', status: 'done', when: '3d', stale: true },
];

export interface MockMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
}

export const MOCK_CONVERSATION: MockMessage[] = [
  { id: 'm1', role: 'user', text: 'Come up with some cool ways to collapse the sidebars in the desktop UI.' },
  {
    id: 'm2',
    role: 'agent',
    text: 'On a project chat page desktop spends ~508px of chrome before the conversation: a 220px main nav plus a 288px session sidebar. The most interesting wins collapse both together. Try the Focus Mode toggle in the top-right — it cycles Default → Focus → Zen.',
  },
  { id: 'm3', role: 'user', text: "Nice. What does each state actually do?" },
  {
    id: 'm4',
    role: 'agent',
    text: 'Default is today\u2019s layout. Focus shrinks the nav to a 56px icon rail and the sessions to a live status strip (colored dots show running / done / failed). Zen tucks both to glowing edge seams \u2014 hover a seam to peek the full panel as an overlay without reflowing your reading column.',
  },
  { id: 'm5', role: 'user', text: 'Can I still get to a chat fast in Zen?' },
  {
    id: 'm6',
    role: 'agent',
    text: 'Yep \u2014 the floating + stays pinned for New Chat, and hovering the right seam slides the whole session list back over the conversation. Press F (or use the toggle) to cycle. Everything animates with the same 200ms transform the real NavSidebar slide already uses.',
  },
];
