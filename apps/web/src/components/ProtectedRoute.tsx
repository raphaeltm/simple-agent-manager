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
      <div style={{
        minHeight: 'var(--sam-app-height)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--sam-color-bg-canvas)',
      }}>
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
