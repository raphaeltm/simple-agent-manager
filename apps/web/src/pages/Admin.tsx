import type { Tab } from '@simple-agent-manager/ui';
import { PageLayout, Tabs } from '@simple-agent-manager/ui';
import { Navigate, Outlet } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';

const ADMIN_TABS: Tab[] = [
  { id: 'users', label: 'Users', path: 'users' },
  { id: 'credentials', label: 'Credentials', path: 'credentials' },
  { id: 'usage', label: 'Usage', path: 'usage' },
  { id: 'errors', label: 'Errors', path: 'errors' },
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'logs', label: 'Logs', path: 'logs' },
  { id: 'stream', label: 'Stream', path: 'stream' },
  { id: 'analytics', label: 'Analytics', path: 'analytics' },
];

export function Admin() {
  const { isSuperadmin } = useAuth();

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageLayout title="Admin" maxWidth="xl" headerRight={<UserMenu />}>
      <Tabs tabs={ADMIN_TABS} basePath="/admin" />
      <div className="mt-4">
        <Outlet />
      </div>
    </PageLayout>
  );
}
