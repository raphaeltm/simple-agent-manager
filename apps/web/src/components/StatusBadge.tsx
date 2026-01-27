import type { WorkspaceStatus } from '@cloud-ai-workspaces/shared';

interface StatusBadgeProps {
  status: WorkspaceStatus | string;
}

interface StatusStyle {
  bg: string;
  text: string;
  label: string;
}

const defaultStyle: StatusStyle = { bg: 'bg-gray-100', text: 'text-gray-800', label: 'Unknown' };

const statusConfig: Record<string, StatusStyle> = {
  pending: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'Pending' },
  creating: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Creating' },
  running: { bg: 'bg-green-100', text: 'text-green-800', label: 'Running' },
  stopping: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Stopping' },
  stopped: { bg: 'bg-gray-100', text: 'text-gray-800', label: 'Stopped' },
  error: { bg: 'bg-red-100', text: 'text-red-800', label: 'Error' },
};

/**
 * Status badge component for displaying workspace status.
 */
export function StatusBadge({ status }: StatusBadgeProps) {
  const config: StatusStyle = statusConfig[status] ?? defaultStyle;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${config.bg} ${config.text}`}
    >
      {status === 'creating' && (
        <svg className="animate-spin -ml-0.5 mr-1.5 h-3 w-3" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {status === 'running' && (
        <span className="w-1.5 h-1.5 mr-1.5 bg-green-500 rounded-full animate-pulse" />
      )}
      {config.label}
    </span>
  );
}
