import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithGitHub } from '../lib/auth';
import { useAuth } from '../components/AuthProvider';
import { Button, Card, Typography, Container } from '@simple-agent-manager/ui';

/**
 * Landing page with GitHub OAuth sign-in.
 */
export function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate('/dashboard');
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSignIn = async () => {
    try {
      await signInWithGitHub();
    } catch (error) {
      console.error('Failed to sign in:', error);
    }
  };

  return (
    <div style={{
      minHeight: 'var(--sam-app-height)',
      backgroundColor: 'var(--sam-color-bg-canvas)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--sam-space-4)',
    }}>
      <Container maxWidth="sm">
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: 'var(--sam-space-6)' }}>
            <Typography variant="display">Simple Agent Manager</Typography>
            <Typography variant="body-muted" style={{ marginTop: 'var(--sam-space-2)' }}>
              Spin up AI coding environments in seconds
            </Typography>
          </div>

          <Card style={{ padding: 'var(--sam-space-6)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sam-space-4)' }}>
              <div style={{ marginBottom: 'var(--sam-space-4)' }}>
                <Typography variant="body" style={{ fontWeight: 500, marginBottom: 'var(--sam-space-2)' }}>
                  Sign in to get started
                </Typography>
                <Typography variant="caption">
                  Use your GitHub account to manage cloud workspaces
                </Typography>
              </div>

              <Button onClick={handleSignIn} style={{ width: '100%' }} size="lg">
                <svg style={{ height: 24, width: 24, marginRight: 12 }} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
                Sign in with GitHub
              </Button>

              <Typography variant="caption" style={{ marginTop: 'var(--sam-space-3)' }}>
                Secure OAuth authentication &bull; No password needed
              </Typography>
            </div>
          </Card>

          <style>{`.sam-landing-features { grid-template-columns: 1fr; gap: var(--sam-space-3); } @media (min-width: 640px) { .sam-landing-features { grid-template-columns: repeat(3, 1fr); gap: var(--sam-space-4); } }`}</style>
          <div className="sam-landing-features" style={{
            display: 'grid',
            paddingTop: 'var(--sam-space-6)',
          }}>
            {[
              { label: 'Cloud VMs', sub: 'Powered by Hetzner', color: '#60a5fa' },
              { label: 'Claude Code', sub: 'Pre-installed', color: 'var(--sam-color-success)' },
              { label: 'Zero Cost', sub: 'When idle', color: '#c084fc' },
            ].map((item) => (
              <div key={item.label} style={{
                textAlign: 'center',
                padding: 'var(--sam-space-3)',
                backgroundColor: 'var(--sam-color-bg-surface)',
                borderRadius: 'var(--sam-radius-md)',
                border: '1px solid var(--sam-color-border-default)',
              }}>
                <div style={{ fontSize: 'clamp(1.125rem, 2vw, 1.25rem)', fontWeight: 700, color: item.color }}>{item.label}</div>
                <Typography variant="caption">{item.sub}</Typography>
              </div>
            ))}
          </div>

          <Typography variant="caption" style={{ paddingTop: 'var(--sam-space-4)' }}>
            Bring your own Hetzner API token. Pay only for what you use.
          </Typography>
        </div>
      </Container>
    </div>
  );
}
