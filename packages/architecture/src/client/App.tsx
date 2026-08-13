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
        <StateMessage title="Invalid workspace" detail={controller.viewer.error} />
      </Shell>
    );
  }
  return <WorkspaceView api={api} controller={controller} />;
}
