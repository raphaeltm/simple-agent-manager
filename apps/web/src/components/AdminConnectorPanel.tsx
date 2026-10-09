import { Alert, Button, Input, Spinner } from '@simple-agent-manager/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useQueryScope } from '../hooks/useQueryScope';
import {
  blockConnectorClient,
  type ConnectorClient,
  connectorClients,
  type ConnectorSetting,
  saveConnectorSettings,
} from '../lib/api/connector';
import {
  adminConnectorSettingsQueryOptions,
  connectorQueryKeys,
} from '../lib/query-options/connector';
import { ConnectorConnections, connectorDate } from './ConnectorConnections';

const labels: Record<string, string> = {
  enabled: 'Enable Connector',
  writeEnabled: 'Allow writes',
  clientRegistration: 'Client registration',
  allowedRedirectHosts: 'Allowed redirect hosts',
  accessTokenTtlSeconds: 'Access token lifetime (seconds)',
  refreshTokenTtlSeconds: 'Refresh token lifetime (seconds)',
  readRateLimitPerMinute: 'Reads per user per minute',
  writeRateLimitPerMinute: 'Writes per user per minute',
  maxStartsPerUserPerHour: 'Starts per user per hour',
  maxStartsPerUserPerDay: 'Starts per user per day',
};
export function AdminConnectorPanel() {
  const scope = useQueryScope();
  const queryClient = useQueryClient();
  const configQuery = useQuery(adminConnectorSettingsQueryOptions(scope));
  const clientsQuery = useInfiniteQuery({
    queryKey: connectorQueryKeys.clients(scope),
    enabled: Boolean(scope),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => connectorClients(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  // Only explicitly edited keys become overrides. Background query updates never reset drafts.
  const [draft, setDraft] = useState<Record<string, ConnectorSetting['value']>>({});
  const [message, setMessage] = useState<string | null>(null);
  const settings = configQuery.data?.settings;
  const clients = clientsQuery.data?.pages.flatMap((page) => page.clients) ?? [];
  const patch = useMutation({
    mutationFn: (values: Record<string, ConnectorSetting['value'] | null>) =>
      saveConnectorSettings(values),
    onSuccess: (result, values) => {
      queryClient.setQueryData(connectorQueryKeys.adminSettings(scope), result);
      setDraft((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([key]) => !Object.hasOwn(values, key)))
      );
      void queryClient.invalidateQueries({ queryKey: connectorQueryKeys.settings(scope) });
      setMessage(
        Object.values(values).some((value) => value === null)
          ? 'Override removed. The installation default is active.'
          : 'Connector settings saved.'
      );
    },
  });
  const blocking = useMutation({
    mutationFn: (client: ConnectorClient) => blockConnectorClient(client.id, !client.blocked),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectorQueryKeys.clients(scope) }),
  });
  const busy = patch.isPending || blocking.isPending;
  const failure = patch.error ?? blocking.error ?? configQuery.error ?? clientsQuery.error;
  const error =
    failure instanceof Error ? failure.message : failure ? 'Could not update Connector' : null;
  const changed = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(settings?.[key]?.value)
    )
  );
  function edit(key: string, value: ConnectorSetting['value']) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setMessage(null);
  }
  function save() {
    if (!Object.keys(changed).length) return;
    setMessage(null);
    patch.mutate(changed);
  }
  return (
    <section
      className="space-y-5 border-t border-border-default pt-6 min-w-0"
      aria-label="Connector"
    >
      <div>
        <h2 className="text-xl font-semibold">Connector</h2>
        <p className="text-sm text-fg-muted">
          Manage access from Claude, ChatGPT, and other AI apps.
        </p>
      </div>
      {error && <Alert variant="error">{error}</Alert>}
      {message && <Alert variant="success">{message}</Alert>}
      {!settings ? (
        !error && <Spinner />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(settings).map(([key, stored]) => {
              const setting = { ...stored, value: draft[key] ?? stored.value };
              return (
                <div key={key} className="min-w-0 space-y-1">
                  <label className="text-sm font-medium block" htmlFor={`connector-${key}`}>
                    {labels[key] ?? key}
                  </label>
                  {typeof setting.value === 'boolean' ? (
                    <Button
                      id={`connector-${key}`}
                      type="button"
                      variant={setting.value ? 'primary' : 'secondary'}
                      role="switch"
                      aria-label={labels[key] ?? key}
                      aria-checked={setting.value}
                      disabled={busy}
                      onClick={() => edit(key, !setting.value)}
                    >
                      {setting.value ? 'Enabled' : 'Disabled'}
                    </Button>
                  ) : key === 'clientRegistration' ? (
                    <select
                      id={`connector-${key}`}
                      className="w-full p-2 rounded border border-border-default bg-bg-primary"
                      disabled={busy}
                      value={String(setting.value)}
                      onChange={(e) => edit(key, e.target.value)}
                    >
                      <option value="open">Open — each user still consents</option>
                      <option value="allowlist">Allowed redirect hosts only</option>
                    </select>
                  ) : (
                    <Input
                      id={`connector-${key}`}
                      disabled={busy}
                      type={typeof setting.value === 'number' ? 'number' : 'text'}
                      min={typeof setting.value === 'number' ? 1 : undefined}
                      value={
                        Array.isArray(setting.value)
                          ? setting.value.join(', ')
                          : String(setting.value)
                      }
                      onChange={(e) =>
                        edit(
                          key,
                          typeof stored.value === 'number'
                            ? Number(e.target.value)
                            : Array.isArray(stored.value)
                              ? e.target.value.split(',').map((value) => value.trim())
                              : e.target.value
                        )
                      }
                    />
                  )}
                  <p className="text-xs text-fg-muted break-words">
                    Source: {setting.source}
                    {setting.updatedAt ? ` · Updated ${connectorDate(setting.updatedAt)}` : ''}
                    {setting.updatedBy ? ` by ${setting.updatedBy}` : ''}
                  </p>
                  {stored.source === 'runtime' && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setMessage(null);
                        patch.mutate({ [key]: null });
                      }}
                      aria-label={`Reset ${labels[key] ?? key} to default`}
                    >
                      Reset to default
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-sm text-fg-muted">
            Disabling the Connector rejects existing tokens without deleting them. When changing
            write access, ChatGPT users must refresh their tool list. Reset to default removes the
            selected override and restores the environment value or built-in default.
          </p>
          <Button type="submit" disabled={busy || !Object.keys(changed).length}>
            {busy ? 'Saving…' : 'Save Connector settings'}
          </Button>
        </form>
      )}
      <ConnectorConnections admin />
      <section className="space-y-3" aria-label="Seen clients">
        <h3 className="text-lg font-semibold">Seen clients</h3>
        {clients.length === 0 ? (
          <p className="text-sm text-fg-muted">No registered clients.</p>
        ) : (
          clients.map((client) => (
            <div
              key={client.id}
              className="border border-border-default rounded-lg p-4 flex flex-wrap gap-3 items-start"
            >
              <div className="flex-1 min-w-0 break-words">
                <p className="font-medium">
                  {client.clientName} {client.blocked && <span className="text-sm">(Blocked)</span>}
                </p>
                <p className="text-sm text-fg-muted">{client.redirectHosts.join(', ')}</p>
                <p className="text-xs text-fg-muted">
                  First seen {connectorDate(client.createdAt)}
                </p>
              </div>
              <Button variant="secondary" disabled={busy} onClick={() => blocking.mutate(client)}>
                {client.blocked ? 'Unblock' : 'Block'}
              </Button>
            </div>
          ))
        )}
        {clientsQuery.hasNextPage && (
          <Button
            variant="secondary"
            disabled={busy || clientsQuery.isFetching}
            onClick={() => void clientsQuery.fetchNextPage({ cancelRefetch: false })}
          >
            Load more clients
          </Button>
        )}
      </section>
    </section>
  );
}
