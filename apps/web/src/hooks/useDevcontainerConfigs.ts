import { useCallback, useEffect, useRef, useState } from 'react';

import type { DevcontainerConfigEntry } from '../lib/api';
import { listProjectDevcontainerConfigs } from '../lib/api';

export interface UseDevcontainerConfigsResult {
  configs: DevcontainerConfigEntry[];
  defaultConfigExists: boolean;
  loading: boolean;
  error: string | null;
  truncated: boolean;
  unsupported: boolean;
  refresh: () => void;
}

/**
 * Fetches devcontainer config options from the project's GitHub repository.
 * Returns an empty/unsupported result gracefully for non-GitHub projects.
 */
export function useDevcontainerConfigs(
  projectId: string | undefined,
  enabled: boolean,
): UseDevcontainerConfigsResult {
  const [configs, setConfigs] = useState<DevcontainerConfigEntry[]>([]);
  const [defaultConfigExists, setDefaultConfigExists] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const fetchIdRef = useRef(0);

  const fetchConfigs = useCallback(() => {
    if (!projectId || !enabled) return;

    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    listProjectDevcontainerConfigs(projectId)
      .then((data) => {
        if (fetchId !== fetchIdRef.current) return;
        if ('unsupported' in data && data.unsupported) {
          setUnsupported(true);
          setConfigs([]);
          setDefaultConfigExists(false);
          setTruncated(false);
        } else {
          setUnsupported(false);
          setConfigs(data.configs ?? []);
          setDefaultConfigExists(data.defaultConfigExists ?? false);
          setTruncated(data.truncated ?? false);
        }
      })
      .catch((err: unknown) => {
        if (fetchId !== fetchIdRef.current) return;
        setError(err instanceof Error ? err.message : 'Failed to load configs');
      })
      .finally(() => {
        if (fetchId !== fetchIdRef.current) return;
        setLoading(false);
      });
  }, [projectId, enabled]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  return {
    configs,
    defaultConfigExists,
    loading,
    error,
    truncated,
    unsupported,
    refresh: fetchConfigs,
  };
}
