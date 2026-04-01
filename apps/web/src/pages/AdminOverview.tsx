import { ErrorTrends } from '../components/admin/ErrorTrends';
import { HealthOverview } from '../components/admin/HealthOverview';

export function AdminOverview() {
  return (
    <div className="flex flex-col gap-4">
      <HealthOverview />
      <ErrorTrends />
    </div>
  );
}
