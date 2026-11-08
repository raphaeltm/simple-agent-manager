import {
  GCP_CLOUD_BILLING_SERVICE,
  GCP_PROJECT_ID_PATTERN,
  type GcpApiIssue,
  type GcpCredentialMetadata,
  gcpEnableApiUrl,
} from '@simple-agent-manager/shared';
import { Alert, Button } from '@simple-agent-manager/ui';

/** What each reason means for the owner, in one sentence. */
function reasonText(issue: GcpApiIssue): string {
  switch (issue.reason) {
    case 'api_disabled':
      return `Google reports the ${issue.label} API is turned off in this project.`;
    case 'permission_denied':
      return `Google refused SAM's service account access to the ${issue.label} API in this project.`;
    case 'not_enabled_by_setup':
      return `This connection was set up before SAM needed the ${issue.label} API, so SAM never turned it on. It may already be on if you enabled it yourself.`;
  }
}

/** What stops working until the API is usable, where SAM knows. */
function consequenceText(service: string): string | null {
  return service === GCP_CLOUD_BILLING_SERVICE
    ? 'Until then, Google Cloud machines show "Price unavailable".'
    : null;
}

interface GcpApiIssuesNoticeProps {
  metadata: GcpCredentialMetadata;
  onRerunSetup: () => void;
  onCheckAgain: () => void;
  checking: boolean;
}

/**
 * Google APIs this connection needs but may not be able to use. SAM cannot turn APIs on with
 * its own service account, so this tells the owner which API, in which project, and how to fix
 * it: the Google Cloud console, re-running SAM's setup (Workload Identity), or a gcloud command
 * (service-account key). "Check again" re-tests after a fix.
 */
export function GcpApiIssuesNotice({
  metadata,
  onRerunSetup,
  onCheckAgain,
  checking,
}: Readonly<GcpApiIssuesNoticeProps>) {
  const issues = metadata.apiIssues ?? [];
  if (issues.length === 0) return null;
  const project = metadata.gcpProjectId;
  // Shown for the owner to paste into a shell, so only offered for a well-formed project id.
  const enableCommand = GCP_PROJECT_ID_PATTERN.test(project)
    ? `gcloud services enable ${issues.map((issue) => issue.service).join(' ')} --project="${project}"`
    : null;

  return (
    <Alert variant="warning" data-testid="gcp-api-issues">
      <div className="flex min-w-0 flex-col gap-3">
        <p className="m-0 font-medium">
          {issues.length === 1
            ? 'A Google API this connection needs may be off in '
            : `${issues.length} Google APIs this connection needs may be off in `}
          <span className="break-all">{project}</span>
        </p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {issues.map((issue) => {
            const consequence = consequenceText(issue.service);
            const enableUrl = gcpEnableApiUrl(issue.service, project);
            return (
              <li key={issue.service} className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{issue.label} API</span>
                  <span className="break-all font-mono text-xs">{issue.service}</span>
                </span>
                <span>
                  {reasonText(issue)}
                  {consequence ? ` ${consequence}` : ''}
                </span>
                {enableUrl && (
                  <a
                    href={enableUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-fit font-medium underline underline-offset-2"
                  >
                    Enable in Google Cloud
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </li>
            );
          })}
        </ul>
        {metadata.authType === 'service-account-key' && enableCommand && (
          <div className="flex min-w-0 flex-col gap-1">
            <span>Or run:</span>
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-2 text-xs text-fg-primary">
              {enableCommand}
            </pre>
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          {metadata.authType === 'workload-identity' && (
            <Button variant="secondary" size="sm" onClick={onRerunSetup}>
              Re-run Google setup
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onCheckAgain}
            loading={checking}
            disabled={checking}
          >
            Check again
          </Button>
        </div>
      </div>
    </Alert>
  );
}
