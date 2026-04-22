import type { Tab } from '@simple-agent-manager/ui';
import { PageLayout, Tabs } from '@simple-agent-manager/ui';
import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';

const SUPERADMIN_TABS: Tab[] = [
  { id: 'platform-infra', label: 'Platform Infra', path: 'platform-infra' },
  { id: 'users', label: 'Users', path: 'users' },
  { id: 'credentials', label: 'Credentials', path: 'credentials' },
  { id: 'ai-proxy', label: 'AI Proxy', path: 'ai-proxy' },
  { id: 'usage', label: 'Usage', path: 'usage' },
  { id: 'quotas', label: 'Quotas', path: 'quotas' },
  { id: 'errors', label: 'Errors', path: 'errors' },
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'logs', label: 'Logs', path: 'logs' },
  { id: 'stream', label: 'Stream', path: 'stream' },
  { id: 'analytics', label: 'Analytics', path: 'analytics' },
];

const ADMIN_TABS: Tab[] = [
  { id: 'platform-infra', label: 'Platform Infra', path: 'platform-infra' },
];

export function Admin() {
  const location = useLocation();
  const { canAccessAdmin, isSuperadmin } = useAuth();

  if (!canAccessAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  if (!isSuperadmin && !location.pathname.startsWith('/admin/platform-infra')) {
    return <Navigate to="/admin/platform-infra" replace />;
  }

  const tabs = isSuperadmin ? SUPERADMIN_TABS : ADMIN_TABS;

  return (
    <PageLayout title="Admin" maxWidth="xl" headerRight={<UserMenu />}>
      <Tabs tabs={tabs} basePath="/admin" />
      <div className="mt-4">
        <Outlet />
      </div>
    </PageLayout>
  );
}
