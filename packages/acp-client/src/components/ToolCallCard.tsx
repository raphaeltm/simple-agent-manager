import { useState } from 'react';
import type { ToolCallItem, ToolCallContentItem } from '../hooks/useAcpMessages';
import { FileDiffView } from './FileDiffView';
import { TerminalBlock } from './TerminalBlock';

interface ToolCallCardProps {
  toolCall: ToolCallItem;
}

/** Status icon for tool call state */
function StatusIcon({ status }: { status: ToolCallItem['status'] }) {
  switch (status) {
    case 'in_progress':
    case 'pending':
      return (
        <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent" />
      );
    case 'completed':
      return (
        <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      );
    case 'failed':
      return (
        <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      );
  }
}

/**
 * Visual card for an agent tool execution.
 * Shows tool name, status, and collapsible output.
 */
export function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = toolCall.content.length > 0;

  return (
    <div className="my-2 border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => hasContent && setExpanded(!expanded)}
        className={`w-full flex items-center justify-between px-3 py-2 bg-gray-50 text-left ${hasContent ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'}`}
      >
        <div className="flex items-center space-x-2">
          <StatusIcon status={toolCall.status} />
          <span className="text-sm font-medium text-gray-700">{toolCall.title}</span>
          {toolCall.toolKind && (
            <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded">
              {toolCall.toolKind}
            </span>
          )}
        </div>
        {toolCall.locations.length > 0 && (
          <span className="text-xs text-gray-500 font-mono truncate ml-2">
            {toolCall.locations[0]?.path}{toolCall.locations[0]?.line ? `:${toolCall.locations[0].line}` : ''}
          </span>
        )}
        {hasContent && (
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>

      {/* Content */}
      {expanded && hasContent && (
        <div className="border-t border-gray-200">
          {toolCall.content.map((content, idx) => (
            <ToolCallContentView key={idx} content={content} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallContentView({ content }: { content: ToolCallContentItem }) {
  switch (content.type) {
    case 'diff':
      return <FileDiffView diff={content.text ?? ''} />;
    case 'terminal':
      return <TerminalBlock output={content.text ?? ''} />;
    case 'content':
    default:
      return content.text ? (
        <div className="p-3 text-sm text-gray-700 whitespace-pre-wrap font-mono text-xs">
          {content.text}
        </div>
      ) : null;
  }
}
