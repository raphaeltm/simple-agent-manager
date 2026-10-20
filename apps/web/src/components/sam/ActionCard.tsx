import { Alert, Button } from '@simple-agent-manager/ui';
import { AlertTriangle, Check, ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { request } from '../../lib/api/client';
import {
  actionTarget,
  confirmationCopy,
  effectTitle,
  linkLabel,
  prettyJson,
  requestErrorText,
  resultLink,
  resultMessage,
} from './sam-receipts';

export interface Action {
  available?: boolean;
  id: string;
  operation: string;
  input_json: string;
  state: string;
  result_json: string | null;
}

const DECLINED_MESSAGE = 'Declined by user';

function ActionStatus({ action, message }: { action: Action; message: string | null }) {
  if (action.available === false) return <span className="text-fg-muted">No longer available</span>;
  switch (action.state) {
    case 'approval_required':
      return (
        <span className="inline-flex items-center gap-1 font-medium text-warning-fg">
          <AlertTriangle size={14} aria-hidden="true" />
          Needs your confirmation
        </span>
      );
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 text-success-fg">
          <Check size={14} aria-hidden="true" />
          Done
        </span>
      );
    case 'uncertain':
      return (
        <span className="inline-flex items-center gap-1 font-medium text-warning-fg">
          <AlertTriangle size={14} aria-hidden="true" />
          Outcome unknown
        </span>
      );
    case 'rejected':
      return (
        <span className="text-fg-muted">
          {message === DECLINED_MESSAGE ? 'Declined' : 'Not run'}
        </span>
      );
    default:
      return <span className="text-fg-muted">In progress</span>;
  }
}

const linkClass =
  'inline-flex min-h-11 items-center gap-1 font-medium text-accent underline underline-offset-2';

/**
 * One recorded SAM effect. The card says in plain words what SAM did or wants to
 * do, where, and what confirming will cause; the exact recorded request stays
 * one tap away for anyone who wants to check it.
 */
export function ActionCard({
  action,
  projectName,
  refresh,
}: {
  action: Action;
  projectName?: string;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = action.available !== false;
  const needsConfirmation = available && action.state === 'approval_required';
  const copy = confirmationCopy(action.operation);
  const message = resultMessage(action.result_json);
  const result = available ? resultLink(action.result_json) : null;
  const target = available ? actionTarget(action) : null;
  const run = async (path: string, body: string, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/sam/actions/${encodeURIComponent(action.id)}/${path}`, {
        method: 'POST',
        body,
      });
    } catch (cause) {
      setError(requestErrorText(cause, failure));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <div
      className={`mt-3 min-w-0 rounded-lg border p-3 text-sm [overflow-wrap:anywhere] ${
        needsConfirmation ? 'border-warning/40 bg-warning-tint' : 'border-border-default bg-surface'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="font-semibold text-fg-primary">{effectTitle(action.operation)}</p>
        <ActionStatus action={action} message={message} />
      </div>
      {target && <p className="mt-1 text-fg-muted">In {projectName ?? 'one of your projects'}</p>}
      {needsConfirmation && <p className="mt-2 text-fg-primary">{copy.consequence}</p>}
      {available && action.state === 'uncertain' && (
        <p className="mt-2 text-fg-primary">
          SAM couldn’t confirm whether this finished. Check the project before asking again.
        </p>
      )}
      {!available && message && <p className="mt-2 text-fg-muted">{message}</p>}
      {result ? (
        result.internal ? (
          <Link className={linkClass} to={result.href}>
            {result.label}
          </Link>
        ) : (
          <a className={linkClass} href={result.href} target="_blank" rel="noopener noreferrer">
            {result.label}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        )
      ) : (
        target &&
        action.state !== 'rejected' && (
          <Link className={linkClass} to={target.path}>
            {linkLabel(target.path)}
          </Link>
        )
      )}
      {needsConfirmation && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant={copy.danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() =>
              void run('confirm', JSON.stringify({ approved: true }), 'Could not confirm')
            }
          >
            {copy.confirm}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run('confirm', JSON.stringify({ approved: false }), 'Could not decline')
            }
          >
            {copy.decline}
          </Button>
        </div>
      )}
      {available && action.state === 'uncertain' && action.operation === 'sam_chat_start' && (
        <Button
          className="mt-2"
          variant="secondary"
          disabled={busy}
          onClick={() => void run('reconcile', '{}', 'Could not check the outcome')}
        >
          {busy ? 'Checking…' : 'Check outcome'}
        </Button>
      )}
      {available && (
        <details className="group mt-2">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-fg-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="transition-transform group-open:rotate-90"
            />
            Exact request
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-inset p-2 text-xs [overflow-wrap:anywhere]">
            {prettyJson(action.input_json)}
          </pre>
          {action.result_json && (
            <>
              <p className="mt-2 text-xs text-fg-muted">Recorded result</p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-inset p-2 text-xs [overflow-wrap:anywhere]">
                {prettyJson(action.result_json)}
              </pre>
            </>
          )}
        </details>
      )}
      {error && (
        <Alert variant="error" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}
