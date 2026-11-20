import { StrandedNodesPanel } from '../components/admin/StrandedNodesPanel';
import { DefaultCapacityPoolsPanel } from '../components/project-settings/DefaultCapacityPoolsPanel';

export function AdminInfrastructure() {
  return (
    <div className="grid gap-4 min-w-0">
      <DefaultCapacityPoolsPanel scope="installation" />
      <StrandedNodesPanel />
    </div>
  );
}
