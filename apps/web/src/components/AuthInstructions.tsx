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
    <div className="rounded-lg bg-blue-50 border border-blue-200 p-6">
      <h3 className="text-lg font-semibold text-blue-900 mb-3">
        Authenticate Claude Code
      </h3>

      <div className="space-y-4 text-blue-800">
        <p className="text-sm">
          Your workspace is ready! To use Claude Code, you need to authenticate with your Claude Max subscription.
        </p>

        <div className="bg-white rounded-md p-4 border border-blue-200">
          <h4 className="font-medium text-blue-900 mb-2">Quick Setup:</h4>
          <ol className="list-decimal list-inside space-y-2 text-sm">
            <li>
              {workspaceUrl ? (
                <>
                  Open your workspace:{' '}
                  <a
                    href={workspaceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-blue-600 hover:text-blue-700 underline"
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
              <code className="block mt-1 bg-gray-100 px-2 py-1 rounded font-mono text-gray-900">
                claude login
              </code>
            </li>
            <li>Follow the browser prompts to authenticate with your Claude Max account</li>
            <li>Once authenticated, Claude Code will be ready to use!</li>
          </ol>
        </div>

        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3">
          <p className="text-xs text-yellow-800">
            <strong>Note:</strong> Claude Max subscription is required. The workspace does not include an API key -
            you authenticate directly through your browser using <code className="font-mono">claude login</code>.
          </p>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-blue-700 hover:text-blue-800 font-medium">
            Troubleshooting
          </summary>
          <div className="mt-2 space-y-2 text-gray-700">
            <div>
              <strong>Authentication fails:</strong>
              <ul className="list-disc list-inside ml-2 mt-1">
                <li>Ensure you have an active Claude Max subscription</li>
                <li>Try clearing browser cookies for claude.ai</li>
                <li>Use an incognito/private browser window</li>
              </ul>
            </div>
            <div>
              <strong>Command not found:</strong>
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