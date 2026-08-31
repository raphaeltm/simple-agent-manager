import type { NodeResponse, WorkspaceResponse } from '@simple-agent-manager/shared';
import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';

import { getNode, getWorkspace } from '../../lib/api';

const DEFAULT_INFRA_FETCH_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

function configuredInfrastructureRetryDelays(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_INFRA_FETCH_RETRY_DELAYS_MS;
  const delays = raw.split(',').map((entry) => Number.parseInt(entry.trim(), 10));
  return delays.length > 0 && delays.every((delay) => Number.isSafeInteger(delay) && delay >= 0)
    ? delays
    : DEFAULT_INFRA_FETCH_RETRY_DELAYS_MS;
}

const INFRA_FETCH_RETRY_DELAYS_MS = configuredInfrastructureRetryDelays(
  import.meta.env.VITE_SESSION_INFRA_RETRY_DELAYS_MS
);

function useRetryingInfrastructureResource<TResource>(
  resourceId: string | null | undefined,
  loadedResourceId: string | null | undefined,
  loadResource: (resourceId: string) => Promise<TResource>,
  setResource: Dispatch<SetStateAction<TResource | null>>
) {
  useEffect(() => {
    const id = resourceId;
    if (!id) return;
    if (loadedResourceId === id) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    async function attemptFetch(attempt = 0) {
      if (!id) return;
      try {
        const resource = await loadResource(id);
        if (cancelled) return;
        setResource(resource);
      } catch {
        if (cancelled) return;
        if (attempt < INFRA_FETCH_RETRY_DELAYS_MS.length) {
          retryTimer = setTimeout(
            () => attemptFetch(attempt + 1),
            INFRA_FETCH_RETRY_DELAYS_MS[attempt]
          );
        }
      }
    }

    attemptFetch();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [resourceId, loadedResourceId, loadResource, setResource]);
}

export function useSessionInfrastructure(workspaceId: string | null | undefined): {
  workspace: WorkspaceResponse | null;
  node: NodeResponse | null;
} {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [node, setNode] = useState<NodeResponse | null>(null);

  useRetryingInfrastructureResource(workspaceId, workspace?.id, getWorkspace, setWorkspace);
  useRetryingInfrastructureResource(workspace?.nodeId, node?.id, getNode, setNode);

  return { workspace, node };
}
