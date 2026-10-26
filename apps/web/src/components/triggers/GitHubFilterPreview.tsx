import type {
  GitHubFilterPreviewResponse,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { request } from '../../lib/api/client';
import { useProjectContext } from '../../pages/ProjectContext';

/** A snapshot of draft settings, no trigger save and no delivery replay. */
export function GitHubFilterPreview({
  eventType,
  filters,
}: {
  eventType: GitHubTriggerEventType;
  filters: GitHubTriggerFilters;
}) {
  const { projectId } = useProjectContext();
  const [result, setResult] = useState<{ draft: string; data: GitHubFilterPreviewResponse }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const draft = JSON.stringify({ eventType, filters });
  async function test() {
    setBusy(true);
    setError('');
    try {
      const data = await request<GitHubFilterPreviewResponse>(
        `/api/projects/${projectId}/triggers/github/filter-preview`,
        { method: 'POST', body: draft }
      );
      setResult({ draft, data });
    } catch {
      setError('Could not test recent deliveries. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-t border-border-default pt-3 text-sm">
      <Button
        variant="secondary"
        size="sm"
        disabled={busy || !projectId}
        onClick={() => void test()}
      >
        {busy ? 'Testing…' : 'Test against recent deliveries'}
      </Button>
      {error && (
        <p role="alert" className="text-danger-fg">
          {error}
        </p>
      )}
      {result && (
        <div aria-live="polite" className="mt-2 space-y-2">
          {result.draft !== draft && (
            <p className="text-warning-fg">
              Settings changed. Test again to refresh these results.
            </p>
          )}
          <p className="text-xs text-fg-muted">{result.data.warning}</p>
          {!result.data.deliveries.length && (
            <p>No recent deliveries for this event and repository.</p>
          )}
          <ul className="list-none p-0 space-y-2">
            {result.data.deliveries.map((row) => (
              <li key={row.id} className="break-words">
                <span className="font-medium">
                  {row.matched === null
                    ? 'Unavailable'
                    : row.matched
                      ? 'Would match'
                      : 'Would not match'}
                </span>
                {' · '}
                {row.eventType}
                {row.action ? ` / ${row.action}` : ''}
                {' · '}
                {row.receivedAt}
                <p className="m-0 text-xs text-fg-muted">{row.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
