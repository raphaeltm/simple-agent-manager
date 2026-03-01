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
    <div className="min-h-[var(--sam-app-height)] bg-canvas flex flex-col items-center justify-center p-4">
      <Container maxWidth="sm">
        <Card>
          <div className="p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-surface-hover flex items-center justify-center mx-auto mb-4">
              <Clock size={24} className="text-fg-muted" />
            </div>

            <PageTitle className="mb-2">
              Awaiting Approval
            </PageTitle>

            <Body className="text-fg-muted mb-2">
              Your account has been created, but an administrator needs to approve
              your access before you can use SAM.
            </Body>

            {user?.email && (
              <Secondary className="mb-6">
                Signed in as {user.email}
              </Secondary>
            )}

            <div className="flex gap-3 justify-center">
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
