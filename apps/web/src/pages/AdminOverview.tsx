import { HealthOverview } from '../components/admin/HealthOverview';
import { ErrorTrends } from '../components/admin/ErrorTrends';

export function AdminOverview() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
      <HealthOverview />
      <ErrorTrends />
    </div>
  );
}
