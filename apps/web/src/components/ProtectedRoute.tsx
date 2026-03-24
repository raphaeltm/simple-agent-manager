import { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Spinner } from '@simple-agent-manager/ui';
import { useAuth } from './AuthProvider';
import { PendingApproval } from '../pages/PendingApproval';

interface ProtectedRouteProps {
  children: ReactNode;
  /** If true, skip the approval check (for the pending page itself) */
  skipApprovalCheck?: boolean;
}

export function ProtectedRoute({ children, skipApprovalCheck }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, isApproved, isRefetching, user } = useAuth();
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

  if (!isAuthenticated) {
    return <Navigate to="/" state={{ from: location }} replace />;
  }

  // Show pending approval page if user is not approved
  if (!skipApprovalCheck && !isApproved && user?.status === 'pending') {
    return <PendingApproval />;
  }

  return <>{children}</>;
}
