import type {
  GitHubFilterPreviewResponse,
  GitHubTriggerEventType,
  GitHubTriggerFilters,
} from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { ApiClientError, request } from '../../lib/api/client';
import { whenLabel } from '../../pages/automation/time';
import { useProjectContext } from '../../pages/ProjectContext';
import { GITHUB_EVENT_OPTIONS, githubFilterChoiceError } from './trigger-form-support';

/** A snapshot of draft settings; testing never starts work or replays a delivery. */
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
  const invalid = githubFilterChoiceError(filters);
  async function test() {
    setResult(undefined);
    setError('');
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      const data = await request<GitHubFilterPreviewResponse>(
        `/api/projects/${projectId}/triggers/github/filter-preview`,
        { method: 'POST', body: draft }
      );
      setResult({ draft, data });
    } catch (cause) {
      setError(
        cause instanceof ApiClientError && cause.status === 400
          ? cause.message
          : 'Could not test recent deliveries. Try again.'
      );
    } finally {
      setBusy(false);
    }
  }
  const rows = result?.data.deliveries ?? [];
  const checked = rows.filter((row) => row.matched !== null);
  const matches = checked.filter((row) => row.matched).length;
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
      <div aria-live="polite" aria-atomic="true" className="mt-2 space-y-2">
        {result && (
          <>
            {result.draft !== draft && (
              <p className="text-warning-fg">
                Settings changed. Test again to refresh these results.
              </p>
            )}
            {rows.length ? (
              <p>
                Checked the last {rows.length} deliveries: {matches} would match,{' '}
                {checked.length - matches} would not match, {rows.length - checked.length} cannot be
                checked.
              </p>
            ) : (
              <p>No recent deliveries for this event and repository.</p>
            )}
            <p className="text-xs text-fg-muted">{result.data.warning}</p>
            {!!checked.length && (
              <ul className="list-none p-0 space-y-2">
                {checked.map((row) => (
                  <li key={row.id} className="break-words">
                    <span className="font-medium">
                      {row.matched ? 'Would match' : 'Would not match'}
                    </span>
                    {' · '}
                    {GITHUB_EVENT_OPTIONS.find((option) => option.value === row.eventType)?.label ??
                      'GitHub activity'}
                    {row.action ? ` · ${row.action.replaceAll('_', ' ')}` : ''}
                    {' · '}
                    {Number.isFinite(Date.parse(row.receivedAt))
                      ? whenLabel(Date.parse(row.receivedAt))
                      : 'Time unavailable'}
                    <p className="m-0 text-xs text-fg-muted">
                      {row.reason === 'matched' ? 'All configured conditions passed.' : row.reason}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
