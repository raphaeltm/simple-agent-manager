import { Button, paneClassName } from '@simple-agent-manager/ui';
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
    // The glass class sits on a wrapper: a closed <details> does not render its content, so a
    // pane that is itself a <details> fails the fixed-position containing-block check.
    <div className={`${paneClassName('slab')} shrink-0 px-4 text-sm`}>
      <details data-testid="retained-snapshot-export">
        <summary className="min-h-11 cursor-pointer rounded py-3 text-fg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary">
          Download saved work
        </summary>
        <div className="space-y-3 pb-3.5">
          <p className="text-xs text-fg-muted">
            Download the saved manifest or Git WIP bundle without starting the agent. Downloads may
            contain private code. Save them somewhere private.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="raised"
              className="min-h-11"
              disabled={busy !== null}
              onClick={() => void download('manifest')}
            >
              {busy === 'manifest' ? 'Preparing manifest…' : 'Download manifest'}
            </Button>
            <Button
              variant="raised"
              className="min-h-11"
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
    </div>
  );
}
