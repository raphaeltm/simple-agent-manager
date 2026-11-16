import type { Tab } from '@simple-agent-manager/ui';
import { PageLayout, Tabs } from '@simple-agent-manager/ui';
import { Navigate, Outlet } from 'react-router';

import { useAuth } from '../components/AuthProvider';

/** Admin sections, grouped the way the Insights prototype lays them out. */
const ADMIN_TABS: Tab[] = [
  { id: 'users', label: 'Users', path: 'users', group: 'People' },
  { id: 'approvals', label: 'Approvals', path: 'approvals', group: 'People' },
  { id: 'quotas', label: 'Quotas', path: 'quotas', group: 'People' },
  { id: 'settings', label: 'Settings', path: 'settings', group: 'Platform' },
  { id: 'integrations', label: 'Integrations', path: 'integrations', group: 'Platform' },
  { id: 'credentials', label: 'Credentials', path: 'credentials', group: 'Platform' },
  { id: 'infrastructure', label: 'Infrastructure', path: 'infrastructure', group: 'Platform' },
  { id: 'storage', label: 'Storage', path: 'storage', group: 'Platform' },
  { id: 'ai-proxy', label: 'AI Proxy', path: 'ai-proxy', group: 'Platform' },
  { id: 'project-events', label: 'Eventing', path: 'project-events', group: 'Platform' },
  { id: 'health-cost', label: 'Health & cost', path: 'health-cost', group: 'Spend and health' },
  { id: 'costs', label: 'Costs', path: 'costs', group: 'Spend and health' },
  { id: 'usage', label: 'Usage', path: 'usage', group: 'Spend and health' },
  { id: 'analytics', label: 'Analytics', path: 'analytics', group: 'Spend and health' },
  { id: 'overview', label: 'Overview', path: 'overview', group: 'Operations' },
  { id: 'errors', label: 'Errors', path: 'errors', group: 'Operations' },
  { id: 'diagnoses', label: 'Diagnoses', path: 'diagnoses', group: 'Operations' },
  { id: 'logs', label: 'Logs', path: 'logs', group: 'Operations' },
  { id: 'stream', label: 'Stream', path: 'stream', group: 'Operations' },
];

export function Admin() {
  const { isSuperadmin } = useAuth();

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageLayout title="Admin" maxWidth="xl">
      <Tabs tabs={ADMIN_TABS} basePath="/admin" />
      <div className="mt-4">
        <Outlet />
      </div>
    </PageLayout>
  );
}
