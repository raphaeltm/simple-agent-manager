import { DefaultCapacityPoolsPanel } from '../components/project-settings/DefaultCapacityPoolsPanel';

export function SettingsInfrastructure() {
  return (
    <div className="grid gap-4 min-w-0">
      <section className="glass-surface rounded-lg p-4">
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Infrastructure</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">
          Configure the compute resources SAM may use for your work. Provider credentials stay on
          the Cloud Provider page; this page controls infrastructure placement.
        </p>
      </section>

      <DefaultCapacityPoolsPanel scope="user" />
    </div>
  );
}
