import type { DiagnosticIncidentSummary } from '@simple-agent-manager/shared';
import { Button, Card } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { downloadAdminDiagnosticArtifact } from '../../lib/api';

interface DiagnosticIncidentCardProps {
  errorId: string | null;
  incident: DiagnosticIncidentSummary | null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function statusCopy(incident: DiagnosticIncidentSummary | null): string {
  if (!incident) return 'No automatic VM evidence is associated with this error.';
  if (incident.status === 'pending')
    return 'The VM report is durable. Its bounded automatic evidence is still being collected or uploaded.';
  if (incident.status === 'failed')
    return incident.failureReason ?? 'Automatic evidence could not be collected or retained.';
  if (incident.status === 'expired')
    return 'The automatic artifact reached its configured retention limit and is no longer available.';
  return 'A bounded, allowlisted, recursively redacted automatic VM snapshot is available.';
}

export function DiagnosticIncidentCard({ errorId, incident }: DiagnosticIncidentCardProps) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const availableArtifact = incident?.artifacts.find((artifact) => artifact.status === 'available');

  const download = async () => {
    if (!errorId || !availableArtifact || downloadingId) return;
    setDownloadingId(availableArtifact.id);
    setDownloadMessage(null);
    setDownloadError(null);
    try {
      await downloadAdminDiagnosticArtifact(errorId, availableArtifact.id);
      setDownloadMessage('Safe automatic evidence downloaded.');
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : 'Evidence download failed.');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-default px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Automatic VM evidence</h2>
          <p className="mt-1 break-words text-xs text-fg-muted">{statusCopy(incident)}</p>
        </div>
        <span className="shrink-0 rounded-full bg-surface px-2.5 py-1 text-xs font-semibold uppercase text-fg-primary">
          {incident?.status ?? 'missing'}
        </span>
      </div>

      {incident && (
        <div className="space-y-4 p-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="text-xs text-fg-muted">Incident</div>
              <div className="mt-1 break-all font-mono text-xs">{incident.id}</div>
            </div>
            <div>
              <div className="text-xs text-fg-muted">Occurrences</div>
              <div className="mt-1">
                {incident.occurrenceCount}
                {incident.occurrenceCount > 1
                  ? ` · last ${new Date(incident.lastSeenAt).toLocaleString()}`
                  : ''}
              </div>
            </div>
            <div>
              <div className="text-xs text-fg-muted">Snapshot size</div>
              <div className="mt-1">{formatBytes(incident.totalBytes)}</div>
            </div>
            <div>
              <div className="text-xs text-fg-muted">Expires</div>
              <div className="mt-1">{new Date(incident.expiresAt).toLocaleString()}</div>
            </div>
          </div>

          {incident.manifest?.collectors.length ? (
            <div>
              <h3 className="text-xs font-semibold uppercase text-fg-muted">Collectors</h3>
              <ul className="mt-2 grid gap-2 md:grid-cols-2">
                {incident.manifest.collectors.map((collector) => (
                  <li
                    key={collector.name}
                    className="min-w-0 rounded border border-border-default p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="break-words font-medium">{collector.name}</span>
                      <span className="text-xs uppercase text-fg-muted">{collector.status}</span>
                    </div>
                    <div className="mt-1 text-xs text-fg-muted">
                      {formatBytes(collector.bytes)} · {collector.redactions} redactions
                      {collector.truncated ? ' · truncated' : ''}
                    </div>
                    {collector.error && (
                      <p className="mt-1 break-words text-xs text-danger-fg">{collector.error}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {incident.preview && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Safe evidence preview
              </summary>
              <pre className="mt-2 max-h-72 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-3 text-xs">
                {JSON.stringify(incident.preview, null, 2)}
              </pre>
            </details>
          )}

          {availableArtifact && (
            <Button
              size="sm"
              variant="secondary"
              disabled={downloadingId !== null}
              onClick={() => void download()}
            >
              {downloadingId === availableArtifact.id ? 'Downloading…' : 'Download safe evidence'}
            </Button>
          )}
          {(downloadMessage || downloadError) && (
            <p
              role={downloadError ? 'alert' : 'status'}
              aria-live="polite"
              className={downloadError ? 'text-sm text-danger-fg' : 'text-sm text-fg-muted'}
            >
              {downloadError ?? downloadMessage}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-border-default bg-surface px-4 py-3 text-xs text-fg-muted">
        This automatic artifact is deliberately narrow and safe for diagnosis. The separate live
        node debug package is broader, operator-initiated, and is never captured or fed to the
        diagnosis model automatically.
      </div>
    </Card>
  );
}
