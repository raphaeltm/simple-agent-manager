import type { GcpCredentialMetadata } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';

interface GcpConnectionDetailsProps {
  metadata: GcpCredentialMetadata | undefined;
  onRotateKey: () => void;
  onDisconnect: () => void;
}

/** The connected Google Cloud credential's safe metadata, with rotate and disconnect actions. */
export function GcpConnectionDetails({
  metadata,
  onRotateKey,
  onDisconnect,
}: Readonly<GcpConnectionDetailsProps>) {
  return (
    <div className="rounded-md border border-success/30 bg-success-tint p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-success-fg">Connected</p>
          <p className="mt-1 text-sm text-fg-muted">
            {metadata?.authType === 'service-account-key'
              ? 'Service account JSON (long-lived key)'
              : 'Workload Identity Federation (recommended)'}
          </p>
          {metadata && (
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-xs text-fg-muted">GCP project</dt>
                <dd className="break-all text-fg-primary">{metadata.gcpProjectId}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-fg-muted">Default zone</dt>
                <dd className="break-all text-fg-primary">{metadata.defaultZone}</dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-xs text-fg-muted">Service account</dt>
                <dd className="break-all text-fg-primary">{metadata.serviceAccountEmail}</dd>
              </div>
              {metadata.privateKeyId && (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-xs text-fg-muted">Private key ID</dt>
                  <dd className="break-all font-mono text-xs text-fg-primary">
                    {metadata.privateKeyId}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:shrink-0">
          {metadata?.authType === 'service-account-key' && (
            <Button variant="secondary" size="sm" onClick={onRotateKey}>
              Rotate JSON key
            </Button>
          )}
          <Button variant="danger" size="sm" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  );
}
