import { Alert, Button } from '@simple-agent-manager/ui';
import { useState } from 'react';
import { Link } from 'react-router';

import { request } from '../../lib/api/client';

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
export function WorkCard({ item, refresh }: { item: Work; refresh: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markSeen = async () => {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/sam/updates/${encodeURIComponent(item.actionId)}/seen`, {
        method: 'POST',
        body: '{}',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not mark updates seen');
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  return (
    <li className="space-y-1 [overflow-wrap:anywhere]">
      <p className="font-medium">{item.taskTitle ?? item.taskId}</p>
      <p>
        {item.projectName ?? item.projectId} · {item.attention ? 'Needs attention · ' : ''}
        {item.status.replaceAll('_', ' ')}
      </p>
      <p className="text-xs text-fg-muted">Checked {new Date(item.observedAt).toLocaleString()}</p>
      <Link
        className="text-accent underline"
        to={`/projects/${encodeURIComponent(item.projectId)}/${item.sessionId ? `chat/${encodeURIComponent(item.sessionId)}` : `tasks/${encodeURIComponent(item.taskId)}`}`}
      >
        Open project work
      </Link>
      {Boolean(item.updates?.unread) && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{item.updates?.unread} unseen updates</span>
          <Button variant="secondary" disabled={busy} onClick={() => void markSeen()}>
            {busy ? 'Saving…' : 'Mark seen'}
          </Button>
        </div>
      )}
      {item.error && <p className="text-fg-muted">{item.error}</p>}
      {error && <Alert variant="error">{error}</Alert>}
    </li>
  );
}
