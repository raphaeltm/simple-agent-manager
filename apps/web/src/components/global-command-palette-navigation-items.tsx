import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  Cloud,
  Cpu,
  DollarSign,
  FolderKanban,
  Gauge,
  Github,
  Home,
  Key,
  KeyRound,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Map,
  MessageSquare,
  Monitor,
  Radio,
  ScrollText,
  Server,
  Settings,
  Shield,
  Users,
  Wrench,
} from 'lucide-react';

import type { NavItem } from './global-command-palette-types';

/** Builds the static (+ superadmin-gated) navigation entries for the command palette. */
export function buildNavigationItems(isSuperadmin: boolean): NavItem[] {
  const items: NavItem[] = [
    { id: 'nav-dashboard', label: 'Home', path: '/dashboard', icon: <Home size={14} /> },
    { id: 'nav-chats', label: 'Chats', path: '/chats', icon: <MessageSquare size={14} /> },
    {
      id: 'nav-projects',
      label: 'Projects',
      path: '/projects',
      icon: <FolderKanban size={14} />,
    },
    { id: 'nav-nodes', label: 'Nodes', path: '/nodes', icon: <Server size={14} /> },
    {
      id: 'nav-workspaces',
      label: 'Workspaces',
      path: '/workspaces',
      icon: <Monitor size={14} />,
    },
    { id: 'nav-map', label: 'Map', path: '/account-map', icon: <Map size={14} /> },
    { id: 'nav-tools', label: 'Tools', path: '/tools', icon: <Wrench size={14} /> },
    { id: 'nav-settings', label: 'Settings', path: '/settings', icon: <Settings size={14} /> },
    // Settings deep-links (always available)
    {
      id: 'nav-settings-cloud-provider',
      label: 'Settings: Cloud Provider',
      path: '/settings/cloud-provider',
      icon: <Cloud size={14} />,
    },
    {
      id: 'nav-settings-github',
      label: 'Settings: GitHub',
      path: '/settings/github',
      icon: <Github size={14} />,
    },
    {
      id: 'nav-settings-agents',
      label: 'Settings: Agents',
      path: '/settings/agents',
      icon: <Bot size={14} />,
    },
    {
      id: 'nav-settings-notifications',
      label: 'Settings: Notifications',
      path: '/settings/notifications',
      icon: <Bell size={14} />,
    },
    {
      id: 'nav-settings-usage',
      label: 'Settings: Usage',
      path: '/settings/usage',
      icon: <BarChart3 size={14} />,
    },
    {
      id: 'nav-settings-api-tokens',
      label: 'Settings: API Tokens',
      path: '/settings/api-tokens',
      icon: <Key size={14} />,
    },
  ];
  if (isSuperadmin) {
    items.push(
      { id: 'nav-admin', label: 'Admin', path: '/admin', icon: <Shield size={14} /> },
      {
        id: 'nav-admin-users',
        label: 'Admin: Users',
        path: '/admin/users',
        icon: <Users size={14} />,
      },
      {
        id: 'nav-admin-credentials',
        label: 'Admin: Credentials',
        path: '/admin/credentials',
        icon: <KeyRound size={14} />,
      },
      {
        id: 'nav-admin-ai-proxy',
        label: 'Admin: AI Proxy',
        path: '/admin/ai-proxy',
        icon: <Cpu size={14} />,
      },
      {
        id: 'nav-admin-trials',
        label: 'Admin: Trials',
        path: '/admin/trials',
        icon: <ListChecks size={14} />,
      },
      {
        id: 'nav-admin-costs',
        label: 'Admin: Costs',
        path: '/admin/costs',
        icon: <DollarSign size={14} />,
      },
      {
        id: 'nav-admin-usage',
        label: 'Admin: Usage',
        path: '/admin/usage',
        icon: <BarChart3 size={14} />,
      },
      {
        id: 'nav-admin-quotas',
        label: 'Admin: Quotas',
        path: '/admin/quotas',
        icon: <Gauge size={14} />,
      },
      {
        id: 'nav-admin-errors',
        label: 'Admin: Errors',
        path: '/admin/errors',
        icon: <AlertTriangle size={14} />,
      },
      {
        id: 'nav-admin-overview',
        label: 'Admin: Overview',
        path: '/admin/overview',
        icon: <LayoutDashboard size={14} />,
      },
      {
        id: 'nav-admin-logs',
        label: 'Admin: Logs',
        path: '/admin/logs',
        icon: <ScrollText size={14} />,
      },
      {
        id: 'nav-admin-stream',
        label: 'Admin: Stream',
        path: '/admin/stream',
        icon: <Radio size={14} />,
      },
      {
        id: 'nav-admin-analytics',
        label: 'Admin: Analytics',
        path: '/admin/analytics',
        icon: <LineChart size={14} />,
      }
    );
  }
  return items;
}
