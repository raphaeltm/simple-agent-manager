import { Alert, Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { request } from '../../lib/api/client';

export interface Action {
  available?: boolean;
  id: string;
  operation: string;
  input_json: string;
  state: string;
  result_json: string | null;
}
function resultLink(json: string | null): string | null {
  try {
    const value: unknown = JSON.parse(json ?? 'null');
    if (!value || typeof value !== 'object' || !('link' in value) || typeof value.link !== 'string')
      return null;
    const url = new URL(value.link, window.location.origin);
    return url.protocol === 'https:' ||
      (url.protocol === 'http:' && url.origin === window.location.origin)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function ActionCard({
  action,
  refresh,
}: {
  action: Action;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = resultLink(action.result_json);
  const confirm = async (approved: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/sam/actions/${encodeURIComponent(action.id)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ approved }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm action');
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const reconcile = async () => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/sam/actions/${encodeURIComponent(action.id)}/reconcile`, {
        method: 'POST',
        body: '{}',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check the outcome');
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 min-w-0 rounded-lg border border-border-default bg-surface-secondary p-3 text-sm [overflow-wrap:anywhere]">
      <p className="font-medium">
        {action.operation.replace(/^sam_/, '').replaceAll('_', ' ')}{' '}
        <span className="font-normal text-fg-muted">· {action.state.replaceAll('_', ' ')}</span>
      </p>
      {link && (
        <a className="mt-2 inline-block text-accent underline" href={link}>
          Open source work
        </a>
      )}
      <details className="mt-2" open={action.state === 'approval_required'}>
        <summary className="cursor-pointer text-accent">Details and recorded result</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all text-xs">{action.input_json}</pre>
        {action.result_json && (
          <pre className="mt-2 whitespace-pre-wrap break-all text-xs">{action.result_json}</pre>
        )}
      </details>
      {action.available !== false &&
        action.state === 'uncertain' &&
        action.operation === 'sam_chat_start' && (
          <Button
            className="mt-3"
            variant="secondary"
            disabled={busy}
            onClick={() => void reconcile()}
          >
            {busy ? 'Checking…' : 'Check outcome'}
          </Button>
        )}
      {action.available !== false && action.state === 'approval_required' && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void confirm(true)}>
            Confirm this action
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void confirm(false)}>
            Decline
          </Button>
        </div>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
