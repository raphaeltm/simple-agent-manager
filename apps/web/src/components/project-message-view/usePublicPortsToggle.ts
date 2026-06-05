import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useState } from 'react';

import { updateWorkspacePortsPublic } from '../../lib/api';

export function usePublicPortsToggle(
  workspace: WorkspaceResponse | null,
  onSessionMutated?: () => void
) {
  const [enabled, setEnabled] = useState(workspace?.portsPublicEnabled ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(workspace?.portsPublicEnabled ?? false);
    setError(null);
  }, [workspace?.id, workspace?.portsPublicEnabled]);

  const toggle = useCallback(async () => {
    if (!workspace?.id || saving) return;
    const nextEnabled = !enabled;
    setEnabled(nextEnabled);
    setSaving(true);
    setError(null);
    try {
      const updated = await updateWorkspacePortsPublic(workspace.id, nextEnabled);
      setEnabled(updated.portsPublicEnabled ?? false);
      onSessionMutated?.();
    } catch (err) {
      setEnabled(!nextEnabled);
      setError(err instanceof Error ? err.message : 'Failed to update port visibility');
    } finally {
      setSaving(false);
    }
  }, [enabled, onSessionMutated, saving, workspace?.id]);

  return {
    enabled,
    saving,
    error,
    toggle,
  };
}
