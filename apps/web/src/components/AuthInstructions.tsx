import { FC } from 'react';

interface AuthInstructionsProps {
  workspaceUrl?: string;
}

/**
 * Component that displays instructions for authenticating Claude Code with Claude Max subscription
 * T087 [US1.5] - Authentication guidance
 */
export const AuthInstructions: FC<AuthInstructionsProps> = ({ workspaceUrl }) => {
  return (
    <div className="rounded-lg bg-info-tint border border-info/30 p-6">
      <h3 className="text-[length:var(--sam-type-section-heading-size)] font-[number:var(--sam-type-section-heading-weight)] text-info-fg mb-3">
        Authenticate Claude Code
      </h3>

      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          Your workspace is ready! To use Claude Code, you need to authenticate with your Claude Max subscription.
        </p>

        <div className="bg-surface rounded-md p-4 border border-border-default">
          <h4 className="font-medium text-fg-primary mb-2">Quick Setup:</h4>
          <ol className="list-decimal list-inside flex flex-col gap-2 text-sm text-fg-muted">
            <li>
              {workspaceUrl ? (
                <>
                  Open your workspace:{' '}
                  <a
                    href={workspaceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-accent underline"
                  >
                    {workspaceUrl}
                  </a>
                </>
              ) : (
                'Open your workspace CloudCLI terminal'
              )}
            </li>
            <li>
              Run the authentication command:
              <code className="block mt-1 bg-inset px-2 py-1 rounded-sm font-mono text-fg-primary text-xs">
                claude login
              </code>
            </li>
            <li>Follow the browser prompts to authenticate with your Claude Max account</li>
            <li>Once authenticated, Claude Code will be ready to use!</li>
          </ol>
        </div>

        <div className="bg-warning-tint border border-warning/30 rounded-md p-3">
          <p className="text-xs text-warning-fg">
            <strong>Note:</strong> Claude Max subscription is required. The workspace does not include an API key -
            you authenticate directly through your browser using <code className="font-mono">claude login</code>.
          </p>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-accent font-medium">
            Troubleshooting
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-fg-muted">
            <div>
              <strong className="text-fg-primary">Authentication fails:</strong>
              <ul className="list-disc list-inside ml-2 mt-1">
                <li>Ensure you have an active Claude Max subscription</li>
                <li>Try clearing browser cookies for claude.ai</li>
                <li>Use an incognito/private browser window</li>
              </ul>
            </div>
            <div>
              <strong className="text-fg-primary">Command not found:</strong>
              <ul className="list-disc list-inside ml-2 mt-1">
                <li>Wait for workspace to fully initialize (2-5 minutes)</li>
                <li>Refresh the CloudCLI page and try again</li>
              </ul>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
};
