import { DefaultCapacityPoolsPanel } from '../components/project-settings/DefaultCapacityPoolsPanel';

export function AdminInfrastructure() {
  return (
    <div className="grid gap-4 min-w-0">
      <section className="glass-surface rounded-lg p-4">
        <h2 className="sam-type-section-heading m-0 text-fg-primary">Infrastructure</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">
          Configure installation-level compute fallback resources. Platform credentials stay on the
          Credentials page; this page controls which concrete provider offerings SAM may place work
          on.
        </p>
      </section>

      <DefaultCapacityPoolsPanel scope="installation" />
    </div>
  );
}
