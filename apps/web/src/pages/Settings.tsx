import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserMenu } from '../components/UserMenu';
import { HetznerTokenForm } from '../components/HetznerTokenForm';
import { GitHubAppSection } from '../components/GitHubAppSection';
import { AgentKeysSection } from '../components/AgentKeysSection';
import { AgentSettingsSection } from '../components/AgentSettingsSection';
import { listCredentials } from '../lib/api';
import type { CredentialResponse } from '@simple-agent-manager/shared';
import { PageLayout, Alert, Skeleton } from '@simple-agent-manager/ui';

/**
 * Settings page with credentials management and agent configuration.
 */
export function Settings() {
  const navigate = useNavigate();
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadCredentials = useCallback(async () => {
    try {
      setError(null);
      const data = await listCredentials();
      setCredentials(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load credentials');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  const hetznerCredential = credentials.find((c) => c.provider === 'hetzner');

  const sectionStyle: React.CSSProperties = {
    backgroundColor: 'var(--sam-color-bg-surface)',
    borderRadius: 'var(--sam-radius-lg)',
    border: '1px solid var(--sam-color-border-default)',
    padding: 'var(--sam-space-6)',
  };

  const sectionHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sam-space-3)',
    marginBottom: 'var(--sam-space-4)',
  };

  const iconBoxStyle = (bg: string): React.CSSProperties => ({
    height: 40,
    width: 40,
    backgroundColor: bg,
    borderRadius: 'var(--sam-radius-md)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  });

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: '1.125rem',
    fontWeight: 500,
    color: 'var(--sam-color-fg-primary)',
  };

  const sectionDescStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    color: 'var(--sam-color-fg-muted)',
  };

  return (
    <PageLayout
      title="Settings"
      onBack={() => navigate('/dashboard')}
      maxWidth="xl"
      headerRight={<UserMenu />}
    >
      {error && (
        <div style={{ marginBottom: 'var(--sam-space-6)' }}>
          <Alert variant="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-6)' }}>
        {/* Hetzner Cloud section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('rgba(239, 68, 68, 0.15)')}>
              <svg style={{ height: 24, width: 24, color: '#f87171' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>Hetzner Cloud</h2>
              <p style={sectionDescStyle}>Connect your Hetzner Cloud account to create workspaces</p>
            </div>
          </div>

          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-3)', padding: 'var(--sam-space-2) 0' }}>
              <Skeleton width="30%" height="0.875rem" />
              <Skeleton width="100%" height="2.5rem" borderRadius="var(--sam-radius-md)" />
              <Skeleton width="80px" height="2.25rem" borderRadius="var(--sam-radius-md)" />
            </div>
          ) : (
            <HetznerTokenForm credential={hetznerCredential} onUpdate={loadCredentials} />
          )}
        </div>

        {/* GitHub App section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('var(--sam-color-bg-inset)')}>
              <svg style={{ height: 24, width: 24, color: 'var(--sam-color-fg-primary)' }} fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>GitHub App</h2>
              <p style={sectionDescStyle}>Install the GitHub App to access your repositories</p>
            </div>
          </div>
          <GitHubAppSection />
        </div>

        {/* Agent API Keys section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('rgba(168, 85, 247, 0.15)')}>
              <svg style={{ height: 24, width: 24, color: '#c084fc' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>Agent API Keys</h2>
              <p style={sectionDescStyle}>Add API keys for AI coding agents. Keys are stored encrypted and used across all your workspaces.</p>
            </div>
          </div>
          <AgentKeysSection />
        </div>

        {/* Agent Settings section */}
        <div style={sectionStyle}>
          <div style={sectionHeaderStyle}>
            <div style={iconBoxStyle('rgba(59, 130, 246, 0.15)')}>
              <svg style={{ height: 24, width: 24, color: '#60a5fa' }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <h2 style={sectionTitleStyle}>Agent Settings</h2>
              <p style={sectionDescStyle}>Configure model selection and permission behavior for each agent. Settings apply to all new sessions.</p>
            </div>
          </div>
          <AgentSettingsSection />
        </div>
      </div>
    </PageLayout>
  );
}
