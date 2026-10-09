import { Alert, Button, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiTokens } from '../components/ApiTokens';
import { ConnectorConnections } from '../components/ConnectorConnections';
import { useQueryScope } from '../hooks/useQueryScope';
import { connectorSettingsQueryOptions } from '../lib/query-options/connector';

export function SettingsApiTokens() {
  const scope = useQueryScope();
  const query = useQuery(connectorSettingsQueryOptions(scope));
  const settings = query.data;
  const [copyError, setCopyError] = useState<string | null>(null);
  const error = copyError ?? query.error?.message;
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!settings) return;
    try {
      await navigator.clipboard.writeText(settings.url);
      setCopied(true);
    } catch {
      setCopyError('Copy failed. Select the Connector URL and copy it manually.');
    }
  }
  return (
    <div className="space-y-8 min-w-0">
      {error && <Alert variant="error">{error}</Alert>}
      {!settings && !error && <Spinner />}
      {settings?.enabled && (
        <section className="space-y-4 min-w-0" aria-label="Connect an AI app">
          <div>
            <h2 className="text-xl font-semibold">Connect an AI app</h2>
            <p className="text-sm text-fg-muted">
              Use SAM from Claude, ChatGPT, or your coding assistant. Each app asks you to approve
              access.
            </p>
          </div>
          {!settings.writeEnabled && (
            <Alert variant="info">
              This installation allows read-only access. Refresh your app’s tool list after an
              administrator changes this setting.
            </Alert>
          )}
          <div className="flex flex-wrap gap-2 items-center">
            <code className="text-sm break-all flex-1 min-w-0 rounded bg-bg-surface p-3">
              {settings.url}
            </code>
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy URL'}
            </Button>
          </div>
          <a
            className="inline-flex items-center min-h-14 rounded-lg bg-accent px-5 font-medium text-fg-on-accent"
            href={`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=SAM&connectorUrl=${encodeURIComponent(settings.url)}`}
            target="_blank"
            rel="noreferrer"
          >
            Add to Claude
          </a>
          <details className="border border-border-default rounded-lg p-4">
            <summary className="cursor-pointer font-medium">Connect ChatGPT</summary>
            <ol className="list-decimal pl-5 mt-3 text-sm space-y-2">
              <li>
                In ChatGPT’s web settings, enable Developer mode if available for your account.
              </li>
              <li>
                Create a custom app or connector using the URL above and OAuth authentication.
              </li>
              <li>
                Connect, sign in to SAM, and review the requested access. App availability on mobile
                depends on your ChatGPT account.
              </li>
            </ol>
          </details>
          <details className="border border-border-default rounded-lg p-4">
            <summary className="cursor-pointer font-medium">Claude Code and Codex</summary>
            <p className="text-sm mt-3">Add SAM, then follow the OAuth sign-in prompt:</p>
            <pre className="whitespace-pre-wrap break-all text-xs mt-2">{`claude mcp add --transport http sam ${settings.url}\ncodex mcp add sam --url ${settings.url}\ncodex mcp login sam`}</pre>
            <p className="text-sm mt-3">
              For token authentication, create an API token below and keep it in
              SAM_CONNECTOR_TOKEN:
            </p>
            <pre className="whitespace-pre-wrap break-all text-xs mt-2">{`claude mcp add --transport http sam ${settings.url} --header "Authorization: Bearer $SAM_CONNECTOR_TOKEN"\ncodex mcp add sam --url ${settings.url} --bearer-token-env-var SAM_CONNECTOR_TOKEN`}</pre>
          </details>
        </section>
      )}
      <ConnectorConnections />
      <ApiTokens />
    </div>
  );
}
