import { useNavigate } from 'react-router-dom';
import { StatusBadge } from './StatusBadge';
import type { WorkspaceResponse } from '@cloud-ai-workspaces/shared';

interface WorkspaceCardProps {
  workspace: WorkspaceResponse;
  onStop?: (id: string) => void;
  onRestart?: (id: string) => void;
  onDelete?: (id: string) => void;
}

/**
 * Card component for displaying a workspace.
 */
export function WorkspaceCard({ workspace, onStop, onRestart, onDelete }: WorkspaceCardProps) {
  const navigate = useNavigate();

  const handleOpen = () => {
    if (workspace.url) {
      window.open(workspace.url, '_blank');
    } else {
      navigate(`/workspaces/${workspace.id}`);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 hover:border-gray-300 transition-colors">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-medium text-gray-900 truncate">
                {workspace.name}
              </h3>
              <StatusBadge status={workspace.status} />
            </div>
            <p className="mt-1 text-sm text-gray-500 truncate">
              {workspace.repository}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {workspace.branch} &middot; {workspace.vmSize} &middot; {workspace.vmLocation}
            </p>
          </div>
        </div>

        {workspace.errorMessage && (
          <div className="mt-3 p-2 bg-red-50 rounded text-xs text-red-600">
            {workspace.errorMessage}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <div className="text-xs text-gray-400">
            {workspace.lastActivityAt
              ? `Last active: ${new Date(workspace.lastActivityAt).toLocaleString()}`
              : `Created: ${new Date(workspace.createdAt).toLocaleString()}`}
          </div>

          <div className="flex items-center space-x-2">
            {workspace.status === 'running' && (
              <>
                <button
                  onClick={handleOpen}
                  className="px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded"
                >
                  Open
                </button>
                {onStop && (
                  <button
                    onClick={() => onStop(workspace.id)}
                    className="px-3 py-1 text-xs font-medium text-orange-600 hover:text-orange-800 hover:bg-orange-50 rounded"
                  >
                    Stop
                  </button>
                )}
              </>
            )}
            {workspace.status === 'stopped' && (
              <>
                {onRestart && (
                  <button
                    onClick={() => onRestart(workspace.id)}
                    className="px-3 py-1 text-xs font-medium text-green-600 hover:text-green-800 hover:bg-green-50 rounded"
                  >
                    Restart
                  </button>
                )}
                {onDelete && (
                  <button
                    onClick={() => onDelete(workspace.id)}
                    className="px-3 py-1 text-xs font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded"
                  >
                    Delete
                  </button>
                )}
              </>
            )}
            {workspace.status === 'error' && onDelete && (
              <button
                onClick={() => onDelete(workspace.id)}
                className="px-3 py-1 text-xs font-medium text-red-600 hover:text-red-800 hover:bg-red-50 rounded"
              >
                Delete
              </button>
            )}
            {(workspace.status === 'creating' || workspace.status === 'stopping') && (
              <span className="text-xs text-gray-400">Please wait...</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
