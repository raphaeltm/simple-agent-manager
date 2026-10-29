import { Breadcrumb, PageLayout, Tabs } from '@simple-agent-manager/ui';
import { Bell, Bot, Cloud, Github, KeyRound, LineChart, Server } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';

import { SamSettingsCard } from '../components/SamSettingsCard';

/**
 * Settings sections. Agents and Infrastructure each hold one kind of account
 * plus that kind's defaults; the former Cloud Provider and Connections tabs
 * redirect into them (see `App.tsx`). The raw credential records page
 * (`/settings/advanced`) is linked from each accounts section.
 */
const SETTINGS_SECTIONS = [
  { id: 'agents', label: 'Agents', path: 'agents', Icon: Bot },
  { id: 'infrastructure', label: 'Infrastructure', path: 'infrastructure', Icon: Cloud },
  { id: 'github', label: 'GitHub', path: 'github', Icon: Github },
  { id: 'mcp-servers', label: 'MCP servers', path: 'mcp-servers', Icon: Server },
  { id: 'notifications', label: 'Notifications', path: 'notifications', Icon: Bell },
  { id: 'usage', label: 'Usage', path: 'usage', Icon: LineChart },
  { id: 'access', label: 'Access', path: 'access', Icon: KeyRound },
] as const;

// Hoisted: `Tabs` reads `tabs` on every render, so a stable array keeps its
// active-tab scroll effect from re-running.
const MOBILE_TABS = SETTINGS_SECTIONS.map(({ id, label, path }) => ({ id, label, path }));

/**
 * Settings shell — a sidebar on wide screens, a scrolling tab strip on phones.
 */
export function Settings() {
  return (
    <PageLayout title="Settings" maxWidth="xl">
      <Breadcrumb segments={[{ label: 'Home', path: '/dashboard' }, { label: 'Settings' }]} />

      <SamSettingsCard />

      <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-[11.5rem_minmax(0,1fr)] md:gap-6">
        <nav aria-label="Settings sections" className="hidden min-w-0 md:block">
          <ul className="sticky top-4 m-0 flex list-none flex-col gap-1 p-0">
            {SETTINGS_SECTIONS.map(({ id, label, path, Icon }) => (
              <li key={id}>
                <NavLink
                  to={`/settings/${path}`}
                  className={({ isActive }) =>
                    `flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm no-underline transition-colors ${
                      isActive
                        ? 'bg-accent-tint font-semibold text-fg-primary'
                        : 'text-fg-muted hover:bg-surface-hover hover:text-fg-primary'
                    }`
                  }
                >
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex min-w-0 flex-col gap-4">
          <Tabs tabs={MOBILE_TABS} basePath="/settings" className="md:hidden" />
          <Outlet />
        </div>
      </div>
    </PageLayout>
  );
}
