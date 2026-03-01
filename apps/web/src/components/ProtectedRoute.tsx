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
  const { isAuthenticated, isLoading, isApproved, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-[var(--sam-app-height)] flex items-center justify-center bg-canvas">
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
