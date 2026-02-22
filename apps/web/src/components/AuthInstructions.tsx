import { FC } from 'react';

interface AuthInstructionsProps {
  workspaceUrl?: string;
}

/**
 * Component that displays instructions for authenticating Claude Code with Claude Max subscription
 * T087 [US1.5] - Authentication guidance
 */
export const AuthInstructions: FC<AuthInstructionsProps> = ({ workspaceUrl }) => {
  const codeStyle: React.CSSProperties = {
    display: 'block',
    marginTop: 'var(--sam-space-1)',
    backgroundColor: 'var(--sam-color-bg-inset)',
    padding: '4px 8px',
    borderRadius: 'var(--sam-radius-sm)',
    fontFamily: 'monospace',
    color: 'var(--sam-color-fg-primary)',
    fontSize: 'var(--sam-type-caption-size)',
  };

  return (
    <div style={{
      borderRadius: 'var(--sam-radius-lg)',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      border: '1px solid rgba(59, 130, 246, 0.3)',
      padding: 'var(--sam-space-6)',
    }}>
      <h3 style={{
        fontSize: 'var(--sam-type-section-heading-size)',
        fontWeight: 'var(--sam-type-section-heading-weight)' as unknown as number,
        color: '#93c5fd',
        marginBottom: 'var(--sam-space-3)',
      }}>
        Authenticate Claude Code
      </h3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
        <p style={{ fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
          Your workspace is ready! To use Claude Code, you need to authenticate with your Claude Max subscription.
        </p>

        <div style={{
          backgroundColor: 'var(--sam-color-bg-surface)',
          borderRadius: 'var(--sam-radius-md)',
          padding: 'var(--sam-space-4)',
          border: '1px solid var(--sam-color-border-default)',
        }}>
          <h4 style={{ fontWeight: 500, color: 'var(--sam-color-fg-primary)', marginBottom: 'var(--sam-space-2)' }}>Quick Setup:</h4>
          <ol style={{ listStyle: 'decimal', listStylePosition: 'inside', display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-2)', fontSize: 'var(--sam-type-secondary-size)', color: 'var(--sam-color-fg-muted)' }}>
            <li>
              {workspaceUrl ? (
                <>
                  Open your workspace:{' '}
                  <a
                    href={workspaceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontFamily: 'monospace', color: 'var(--sam-color-accent-primary)', textDecoration: 'underline' }}
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
              <code style={codeStyle}>
                claude login
              </code>
            </li>
            <li>Follow the browser prompts to authenticate with your Claude Max account</li>
            <li>Once authenticated, Claude Code will be ready to use!</li>
          </ol>
        </div>

        <div style={{
          backgroundColor: 'rgba(245, 158, 11, 0.1)',
          border: '1px solid rgba(245, 158, 11, 0.3)',
          borderRadius: 'var(--sam-radius-md)',
          padding: 'var(--sam-space-3)',
        }}>
          <p style={{ fontSize: 'var(--sam-type-caption-size)', color: '#fbbf24' }}>
            <strong>Note:</strong> Claude Max subscription is required. The workspace does not include an API key -
            you authenticate directly through your browser using <code style={{ fontFamily: 'monospace' }}>claude login</code>.
          </p>
        </div>

        <details style={{ fontSize: 'var(--sam-type-secondary-size)' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--sam-color-accent-primary)', fontWeight: 500 }}>
            Troubleshooting
          </summary>
          <div style={{ marginTop: 'var(--sam-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-2)', color: 'var(--sam-color-fg-muted)' }}>
            <div>
              <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Authentication fails:</strong>
              <ul style={{ listStyle: 'disc', listStylePosition: 'inside', marginLeft: 'var(--sam-space-2)', marginTop: 'var(--sam-space-1)' }}>
                <li>Ensure you have an active Claude Max subscription</li>
                <li>Try clearing browser cookies for claude.ai</li>
                <li>Use an incognito/private browser window</li>
              </ul>
            </div>
            <div>
              <strong style={{ color: 'var(--sam-color-fg-primary)' }}>Command not found:</strong>
              <ul style={{ listStyle: 'disc', listStylePosition: 'inside', marginLeft: 'var(--sam-space-2)', marginTop: 'var(--sam-space-1)' }}>
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
