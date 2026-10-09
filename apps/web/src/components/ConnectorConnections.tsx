import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { AppWindow } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import {
  type ConnectorConnection,
  connectorConnections,
  revokeConnectorConnection,
} from '../lib/api/connector';
import { ConfirmDialog } from './ConfirmDialog';

export function connectorDate(value: string | number | null) {
  return value == null ? 'Never' : new Date(value).toLocaleString();
}
export function ConnectorConnections({ admin = false }: { admin?: boolean }) {
  const [connections, setConnections] = useState<ConnectorConnection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConnectorConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (next?: string) => {
      try {
        const result = await connectorConnections(admin, next);
        setConnections((previous) =>
          next ? [...previous, ...result.connections] : result.connections
        );
        setCursor(result.nextCursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load connected apps');
      } finally {
        setLoading(false);
      }
    },
    [admin]
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function revoke() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await revokeConnectorConnection(target.id, admin);
      setTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke connection');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 min-w-0"
      aria-label={admin ? 'Active connections' : 'Connected apps'}
    >
      <h3 className="text-lg font-semibold">{admin ? 'Active connections' : 'Connected apps'}</h3>
      {error && <Alert variant="error">{error}</Alert>}
      {loading ? (
        <Spinner />
      ) : connections.filter((c) => !c.revokedAt).length === 0 ? (
        <p className="text-sm text-fg-muted">No connected apps.</p>
      ) : (
        connections
          .filter((c) => !c.revokedAt)
          .map((c) => (
            <div
              key={c.id}
              className="border border-border-default rounded-lg p-4 flex flex-wrap items-start gap-3 min-w-0"
            >
              <AppWindow aria-hidden="true" className="shrink-0" size={20} />
              <div className="flex-1 min-w-0 break-words">
                <p className="font-medium">{c.clientName}</p>
                {admin && <p className="text-xs text-fg-muted">User: {c.userId}</p>}
                <p className="text-sm text-fg-muted">{c.scopes.join(', ')}</p>
                <p className="text-xs text-fg-muted">
                  Connected {connectorDate(c.createdAt)} · Last used {connectorDate(c.lastUsedAt)}
                </p>
              </div>
              <Button variant="secondary" onClick={() => setTarget(c)}>
                Revoke
              </Button>
            </div>
          ))
      )}
      {cursor && (
        <Button variant="secondary" disabled={busy} onClick={() => void load(cursor)}>
          Load more connections
        </Button>
      )}
      <ConfirmDialog
        isOpen={!!target}
        onClose={() => {
          if (!busy) setTarget(null);
        }}
        onConfirm={() => void revoke()}
        title="Revoke app access?"
        message={`${target?.clientName ?? 'This app'} will lose access to SAM. You can connect it again later.`}
        confirmLabel="Revoke access"
        loading={busy}
      />
    </section>
  );
}
