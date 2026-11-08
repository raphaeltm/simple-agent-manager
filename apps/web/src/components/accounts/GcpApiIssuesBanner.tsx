import { Alert, Button } from '@simple-agent-manager/ui';

import { useCredentials } from '../../hooks/useCredentials';
import { useQueryScope } from '../../hooks/useQueryScope';

/**
 * Points the owner at their Google Cloud connection when a Google API it needs may be off.
 * The details and the fixes live in the Google Cloud card (`GcpApiIssuesNotice`); this only
 * makes the problem visible on Settings → Infrastructure.
 */
export function GcpApiIssuesBanner({ onReview }: Readonly<{ onReview: () => void }>) {
  const { credentials } = useCredentials(useQueryScope());
  const gcp = credentials.find((credential) => credential.provider === 'gcp')?.gcp;
  const issues = gcp?.apiIssues ?? [];
  if (!gcp || issues.length === 0) return null;
  const labels = issues.map((issue) => issue.label).join(', ');

  return (
    <Alert variant="warning" data-testid="gcp-api-issues-banner">
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="min-w-0 break-words">
          Your Google Cloud project <strong className="break-all">{gcp.gcpProjectId}</strong> may be
          missing {issues.length === 1 ? 'an API' : 'APIs'} SAM needs: {labels}.
        </span>
        <Button variant="secondary" size="sm" onClick={onReview} className="sm:shrink-0">
          Review
        </Button>
      </div>
    </Alert>
  );
}
