import { Navigate, Outlet } from 'react-router-dom';
import { PageLayout, Tabs } from '@simple-agent-manager/ui';
import { useAuth } from '../components/AuthProvider';
import { UserMenu } from '../components/UserMenu';
import type { Tab } from '@simple-agent-manager/ui';

const ADMIN_TABS: Tab[] = [
  { id: 'users', label: 'Users', path: 'users' },
  { id: 'errors', label: 'Errors', path: 'errors' },
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'logs', label: 'Logs', path: 'logs' },
  { id: 'stream', label: 'Stream', path: 'stream' },
];

export function Admin() {
  const { isSuperadmin } = useAuth();

  if (!isSuperadmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <PageLayout title="Admin" maxWidth="xl" headerRight={<UserMenu />}>
      <Tabs tabs={ADMIN_TABS} basePath="/admin" />
      <div style={{ marginTop: 'var(--sam-space-4)' }}>
        <Outlet />
      </div>
    </PageLayout>
  );
}
