import { Alert, Button, Input, Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import {
  adminConnectorSettings,
  blockConnectorClient,
  type ConnectorClient,
  connectorClients,
  type ConnectorSettings,
  saveConnectorSettings,
} from '../lib/api/connector';
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
  const [settings, setSettings] = useState<ConnectorSettings | null>(null);
  const [clientCursor, setClientCursor] = useState<string | null>(null);
  const [clients, setClients] = useState<ConnectorClient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([adminConnectorSettings(), connectorClients()])
      .then(([config, result]) => {
        if (active) {
          setSettings(config.settings);
          setClients(result.clients);
          setClientCursor(result.nextCursor ?? null);
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await saveConnectorSettings(
        Object.fromEntries(Object.entries(settings).map(([key, setting]) => [key, setting.value]))
      );
      setSettings(result.settings);
      setMessage('Connector settings saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save settings');
    } finally {
      setBusy(false);
    }
  }
  async function loadMoreClients() {
    if (!clientCursor) return;
    setBusy(true);
    try {
      const result = await connectorClients(clientCursor);
      setClients((previous) => [...previous, ...result.clients]);
      setClientCursor(result.nextCursor ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load clients');
    } finally {
      setBusy(false);
    }
  }
  async function block(client: ConnectorClient) {
    setBusy(true);
    setError(null);
    try {
      await blockConnectorClient(client.id, !client.blocked);
      setClients((previous) =>
        previous.map((c) => (c.id === client.id ? { ...c, blocked: !c.blocked } : c))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update client');
    } finally {
      setBusy(false);
    }
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
            {Object.entries(settings).map(([key, setting]) => (
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
                    onClick={() =>
                      setSettings({ ...settings, [key]: { ...setting, value: !setting.value } })
                    }
                  >
                    {setting.value ? 'Enabled' : 'Disabled'}
                  </Button>
                ) : key === 'clientRegistration' ? (
                  <select
                    id={`connector-${key}`}
                    className="w-full p-2 rounded border border-border-default bg-bg-primary"
                    disabled={busy}
                    value={String(setting.value)}
                    onChange={(e) =>
                      setSettings({ ...settings, [key]: { ...setting, value: e.target.value } })
                    }
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
                      setSettings({
                        ...settings,
                        [key]: {
                          ...setting,
                          value:
                            typeof setting.value === 'number'
                              ? Number(e.target.value)
                              : Array.isArray(setting.value)
                                ? e.target.value.split(',').map((v) => v.trim())
                                : e.target.value,
                        },
                      })
                    }
                  />
                )}
                <p className="text-xs text-fg-muted break-words">
                  Source: {setting.source}
                  {setting.updatedAt ? ` · Updated ${connectorDate(setting.updatedAt)}` : ''}
                  {setting.updatedBy ? ` by ${setting.updatedBy}` : ''}
                </p>
              </div>
            ))}
          </div>
          <p className="text-sm text-fg-muted">
            Disabling the Connector rejects existing tokens without deleting them. When changing
            write access, ChatGPT users must refresh their tool list.
          </p>
          <Button type="submit" disabled={busy}>
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
              <Button variant="secondary" disabled={busy} onClick={() => void block(client)}>
                {client.blocked ? 'Unblock' : 'Block'}
              </Button>
            </div>
          ))
        )}
        {clientCursor && (
          <Button variant="secondary" disabled={busy} onClick={() => void loadMoreClients()}>
            Load more clients
          </Button>
        )}
      </section>
    </section>
  );
}
