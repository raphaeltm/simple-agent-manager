import { Clock } from 'lucide-react';
import { Button, Card, Container, PageTitle, Body, Secondary } from '@simple-agent-manager/ui';
import { signOut } from '../lib/auth';
import { useAuth } from '../components/AuthProvider';

/**
 * Page shown to authenticated users whose account is pending admin approval.
 */
export function PendingApproval() {
  const { user } = useAuth();

  const handleCheckStatus = () => {
    window.location.reload();
  };

  const handleSignOut = async () => {
    try {
      await signOut();
    } catch (error) {
      console.error('Failed to sign out:', error);
    }
  };

  return (
    <div
      style={{
        minHeight: 'var(--sam-app-height)',
        backgroundColor: 'var(--sam-color-bg-canvas)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sam-space-4)',
      }}
    >
      <Container maxWidth="sm">
        <Card>
          <div style={{ padding: 'var(--sam-space-6)', textAlign: 'center' }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--sam-radius-full)',
                backgroundColor: 'var(--sam-color-bg-surface-hover)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto var(--sam-space-4)',
              }}
            >
              <Clock size={24} style={{ color: 'var(--sam-color-fg-muted)' }} />
            </div>

            <PageTitle style={{ marginBottom: 'var(--sam-space-2)' }}>
              Awaiting Approval
            </PageTitle>

            <Body style={{ color: 'var(--sam-color-fg-muted)', marginBottom: 'var(--sam-space-2)' }}>
              Your account has been created, but an administrator needs to approve
              your access before you can use SAM.
            </Body>

            {user?.email && (
              <Secondary style={{ marginBottom: 'var(--sam-space-6)' }}>
                Signed in as {user.email}
              </Secondary>
            )}

            <div style={{ display: 'flex', gap: 'var(--sam-space-3)', justifyContent: 'center' }}>
              <Button variant="primary" onClick={handleCheckStatus}>
                Check Status
              </Button>
              <Button variant="ghost" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </div>
        </Card>
      </Container>
    </div>
  );
}
