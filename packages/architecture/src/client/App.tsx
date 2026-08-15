import { useMemo } from 'react';

import { createApiClient } from './api';
import { useArchitectureViewer } from './useArchitectureViewer';
import { Shell, StateMessage, WorkspaceView } from './WorkspaceView';

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const controller = useArchitectureViewer(api);
  if (controller.viewer.loading) {
    return (
      <Shell status={controller.viewer.status}>
        <StateMessage title="Loading architecture workspace" />
      </Shell>
    );
  }
  if (controller.viewer.error || !controller.viewer.model) {
    return (
      <Shell status={controller.viewer.status}>
        <section className="invalid-workbench" aria-label="Architecture workspace error">
          <header className="invalid-workbench-head">
            <div>
              <p className="eyebrow">Architecture workspace</p>
              <h1>Workspace model unavailable</h1>
            </div>
            <span>model load failed</span>
          </header>
          <StateMessage title="Invalid workspace" detail={controller.viewer.error} />
          <footer className="workbench-status">
            <span>diagnostic</span>
            <span>model unavailable</span>
            <span>source preserved</span>
          </footer>
        </section>
      </Shell>
    );
  }
  return <WorkspaceView api={api} controller={controller} />;
}
