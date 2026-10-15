import { DefaultCapacityPoolsPanel } from '../components/project-settings/DefaultCapacityPoolsPanel';

export function SettingsInfrastructure() {
  return (
    <div className="grid gap-4 min-w-0">
      <DefaultCapacityPoolsPanel scope="user" />
    </div>
  );
}
