import type { WorkspaceStatus } from '@simple-agent-manager/shared';
import { StatusBadge as SharedStatusBadge } from '@simple-agent-manager/ui';

interface StatusBadgeProps {
  status: WorkspaceStatus | string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <SharedStatusBadge status={String(status)} />;
}
