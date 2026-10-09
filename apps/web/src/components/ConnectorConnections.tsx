import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppWindow } from 'lucide-react';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import {
  type ConnectorConnection,
  connectorConnections,
  revokeConnectorConnection,
} from '../lib/api/connector';
import { connectorQueryKeys } from '../lib/query-options/connector';
import { ConfirmDialog } from './ConfirmDialog';

export function connectorDate(value: string | number | null) {
  return value == null ? 'Never' : new Date(value).toLocaleString();
}
export function ConnectorConnections({ admin = false }: { admin?: boolean }) {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const key = connectorQueryKeys.connections(scope, admin);
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: Boolean(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => connectorConnections(admin, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const [target, setTarget] = useState<ConnectorConnection | null>(null);
  const mutation = useMutation({
    mutationFn: (id: string) => revokeConnectorConnection(id, admin),
    onSuccess: async () => {
      setTarget(null);
      await queryClient.invalidateQueries({ queryKey: connectorQueryKeys.all(scope) });
    },
  });
  const connections = query.data?.pages.flatMap((page) => page.connections) ?? [];
  const loading = query.isPending;
  const loadingMore = query.isFetchingNextPage;
  const busy = mutation.isPending;
  const error = mutation.error?.message ?? query.error?.message;
  function revoke() {
    if (target) mutation.mutate(target.id);
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
              <Button
                variant="secondary"
                disabled={busy || query.isFetching}
                onClick={() => setTarget(c)}
              >
                Revoke
              </Button>
            </div>
          ))
      )}
      {query.hasNextPage && (
        <Button
          variant="secondary"
          disabled={busy || query.isFetching}
          onClick={() => void query.fetchNextPage({ cancelRefetch: false })}
        >
          {loadingMore ? 'Loading connections…' : 'Load more connections'}
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
