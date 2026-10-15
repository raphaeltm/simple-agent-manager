import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import {
  downloadRetainedSnapshot,
  type RetainedSnapshotArtifact,
} from '../../lib/api/retained-snapshots';

/** Owner recovery control works with only the retained session, including after runtime deletion. */
export function RetainedSnapshotExport({
  projectId,
  sessionId,
  isMine,
}: Readonly<{
  projectId: string;
  sessionId: string;
  isMine: boolean;
}>) {
  const [busy, setBusy] = useState<RetainedSnapshotArtifact | null>(null);
  const [error, setError] = useState(false);
  if (!isMine) return null;
  const download = async (artifact: RetainedSnapshotArtifact) => {
    setError(false);
    setBusy(artifact);
    try {
      await downloadRetainedSnapshot(projectId, sessionId, artifact);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <details
      className="shrink-0 border-b border-border-default bg-surface px-4 text-sm"
      data-testid="retained-snapshot-export"
    >
      <summary className="min-h-14 cursor-pointer rounded py-4 text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
        Download saved work
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-fg-muted">
          Download the saved manifest or Git WIP bundle without starting the agent. Downloads may
          contain private code. Save them somewhere private.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="secondary"
            className="min-h-14"
            disabled={busy !== null}
            onClick={() => void download('manifest')}
          >
            {busy === 'manifest' ? 'Preparing manifest…' : 'Download manifest'}
          </Button>
          <Button
            variant="secondary"
            className="min-h-14"
            disabled={busy !== null}
            onClick={() => void download('wip')}
          >
            {busy === 'wip' ? 'Preparing WIP bundle…' : 'Download WIP bundle'}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-danger-fg">
            Saved work could not be downloaded. It may have expired, be unavailable, or no longer
            belong to you. You can try again.
          </p>
        )}
      </div>
    </details>
  );
}
