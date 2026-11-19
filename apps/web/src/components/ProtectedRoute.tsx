import { Button, Spinner } from '@simple-agent-manager/ui';
import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { PendingApproval } from '../pages/PendingApproval';
import { useAuth } from './AuthProvider';

interface ProtectedRouteProps {
  children: ReactNode;
  /** If true, skip the approval check (for the pending page itself) */
  skipApprovalCheck?: boolean;
}

export function ProtectedRoute({ children, skipApprovalCheck }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, isApproved, isRefetching, user, sessionError, retrySession } = useAuth();
  const location = useLocation();

  // Show spinner during initial load or while re-checking session (e.g. after tab regains focus).
  // This prevents false redirects to login during transient network errors on mobile app resume.
  if (isLoading || (isRefetching && !isAuthenticated)) {
    return (
      <div
        className="min-h-[var(--sam-app-height)] flex items-center justify-center bg-canvas"
        role="status"
        aria-label="Verifying your session"
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if (!isAuthenticated && sessionError) {
    return (
      <div className="min-h-[var(--sam-app-height)] flex items-center justify-center bg-canvas p-4">
        <div role="alert" className="glass-surface rounded-lg p-4 grid gap-3 max-w-md">
          <p className="m-0 text-fg-primary">Could not verify your session.</p>
          <p className="m-0 text-sm text-fg-muted">Try again to continue to this page.</p>
          <Button onClick={retrySession}>Retry session verification</Button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  // Show pending approval page if user is not approved
  if (!skipApprovalCheck && !isApproved && user?.status === 'pending') {
    return <PendingApproval />;
  }

  return <>{children}</>;
}
