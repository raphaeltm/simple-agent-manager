import { Alert, Button } from '@simple-agent-manager/ui';
import { ChevronDown, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { request } from '../../lib/api/client';
import { formatRelativeTime } from '../../lib/time-utils';
import { requestErrorText } from './sam-receipts';

export interface Work {
  updates?: { unread: number; lastEventType: string | null; lastEventAt: number | null };
  taskTitle?: string;
  projectName?: string;
  actionId: string;
  projectId: string;
  taskId: string;
  sessionId: string | null;
  status: string;
  link: string;
  observedAt: number;
  attention: boolean;
  error?: string;
}

function statusLabel(status: string): string {
  const words = status.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

const pill = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';

export function WorkCard({
  item,
  projectName,
  refresh,
}: {
  item: Work;
  projectName?: string;
  refresh: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unread = item.updates?.unread ?? 0;
  const markSeen = async () => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/sam/updates/${encodeURIComponent(item.actionId)}/seen`, {
        method: 'POST',
        body: '{}',
      });
    } catch (cause) {
      setError(requestErrorText(cause, 'Could not mark updates seen'));
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const project = `/projects/${encodeURIComponent(item.projectId)}`;
  return (
    <li className="min-w-0 rounded-md border border-border-default bg-surface p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
        <p className="min-w-0 font-medium text-fg-primary">{item.taskTitle ?? 'Untitled task'}</p>
        {item.attention && (
          <span className={`${pill} bg-warning-tint text-warning-fg`}>Needs attention</span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-fg-muted">
        {[
          item.projectName ?? projectName,
          statusLabel(item.status),
          `Checked ${formatRelativeTime(item.observedAt).toLowerCase()}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {item.error && <p className="mt-1 text-xs text-fg-muted">{item.error}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-x-3">
        <Link
          className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-2"
          to={
            item.sessionId
              ? `${project}/chat/${encodeURIComponent(item.sessionId)}`
              : `${project}/tasks/${encodeURIComponent(item.taskId)}`
          }
        >
          {item.sessionId ? 'Open chat' : 'Open task'}
        </Link>
        {unread > 0 && (
          <span className="inline-flex items-center gap-2">
            <span className="text-fg-primary">{plural(unread, 'new update')}</span>
            <Button variant="secondary" disabled={busy} onClick={() => void markSeen()}>
              {busy ? 'Saving…' : 'Mark seen'}
            </Button>
          </span>
        )}
      </div>
      {error && (
        <Alert variant="error" className="mt-2">
          {error}
        </Alert>
      )}
    </li>
  );
}

/**
 * Quiet, always-reachable summary of project work SAM started. Updates never
 * become conversation turns; they wait here until the user opens or dismisses them.
 */
export function WorkPanel({
  work,
  projectNames,
  refresh,
}: {
  work: Work[];
  projectNames: ReadonlyMap<string, string>;
  refresh: () => Promise<unknown>;
}) {
  const attention = work.filter((item) => item.attention).length;
  const unread = work.reduce((total, item) => total + (item.updates?.unread ?? 0), 0);
  return (
    <details className="group min-w-0 rounded-lg border border-border-default bg-surface">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden">
        <ListChecks size={16} aria-hidden="true" className="text-fg-muted" />
        <span className="font-medium text-fg-primary">Project work</span>
        <span className="text-fg-muted">{work.length}</span>
        {attention > 0 && (
          <span className={`${pill} bg-warning-tint text-warning-fg`}>
            {attention} {attention === 1 ? 'needs' : 'need'} attention
          </span>
        )}
        {unread > 0 && (
          <span className={`${pill} bg-accent-tint text-accent`}>
            {plural(unread, 'new update')}
          </span>
        )}
        <ChevronDown
          size={16}
          aria-hidden="true"
          className="ml-auto text-fg-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <ul className="max-h-[40vh] space-y-2 overflow-y-auto border-t border-border-default p-2">
        {work.map((item) => (
          <WorkCard
            key={item.actionId}
            item={item}
            projectName={projectNames.get(item.projectId)}
            refresh={refresh}
          />
        ))}
      </ul>
    </details>
  );
}
