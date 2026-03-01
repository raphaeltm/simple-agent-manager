import { HealthOverview } from '../components/admin/HealthOverview';
import { ErrorTrends } from '../components/admin/ErrorTrends';

export function AdminOverview() {
  return (
    <div className="flex flex-col gap-4">
      <HealthOverview />
      <ErrorTrends />
    </div>
  );
}
