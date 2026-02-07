interface PermissionDialogProps {
  requestId: string;
  toolName: string;
  description: string;
  inputSummary?: string;
  onRespond: (requestId: string, action: 'allow_once' | 'deny') => void;
}

/**
 * Interactive approval dialog for agent permission requests.
 * Shows tool details and Approve/Reject buttons.
 */
export function PermissionDialog({
  requestId,
  toolName,
  description,
  inputSummary,
  onRespond,
}: PermissionDialogProps) {
  return (
    <div className="my-3 border-2 border-yellow-300 bg-yellow-50 rounded-lg p-4">
      <div className="flex items-start space-x-3">
        <div className="flex-shrink-0">
          <svg className="h-6 w-6 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="text-sm font-medium text-yellow-800">Permission Request</h4>
          <p className="mt-1 text-sm text-yellow-700">
            <span className="font-mono font-medium">{toolName}</span>: {description}
          </p>
          {inputSummary && (
            <pre className="mt-2 p-2 bg-white border border-yellow-200 rounded text-xs font-mono text-gray-700 whitespace-pre-wrap max-h-40 overflow-auto">
              {inputSummary}
            </pre>
          )}
          <div className="mt-3 flex space-x-2">
            <button
              onClick={() => onRespond(requestId, 'allow_once')}
              className="px-3 py-1.5 text-sm font-medium bg-green-600 text-white rounded-md hover:bg-green-700"
            >
              Approve
            </button>
            <button
              onClick={() => onRespond(requestId, 'deny')}
              className="px-3 py-1.5 text-sm font-medium bg-red-100 text-red-700 rounded-md hover:bg-red-200"
            >
              Reject
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
