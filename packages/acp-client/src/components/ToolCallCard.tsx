import React, { useState } from 'react';

import type { ToolCallContentItem,ToolCallItem } from '../hooks/useAcpMessages';
import { isJsonRecord } from '../runtime-validation';
import { FileDiffView } from './FileDiffView';
import { normalizeRawToolOutput } from './raw-tool-output';
import { TerminalBlock } from './TerminalBlock';

interface ToolCallCardProps {
  toolCall: ToolCallItem;
  /** Called when a file location is clicked. Receives the file path and optional line number. */
  onFileClick?: (path: string, line?: number | null) => void;
  /** Called to lazy-load tool content when expanding a compact tool call. Returns the content items. */
  onLoadContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
  /** Optional host styling for context-specific presentation. */
  className?: string;
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
 *
 * Wrapped in React.memo to prevent re-renders when parent state changes
 * don't affect this component's props.
 */
export const ToolCallCard = React.memo(function ToolCallCard({ toolCall, onFileClick, onLoadContent, className }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [lazyContent, setLazyContent] = useState<ToolCallContentItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const rawOutputFallback = normalizeRawToolOutput(toolCall.rawOutput);
  const needsLazyLoad = toolCall.contentLoaded === false && !!toolCall.messageId && !!onLoadContent;
  const hasContent = needsLazyLoad || toolCall.content.some(hasRenderableContent) || rawOutputFallback !== null;
  let fallbackContent: ToolCallContentItem[] = [];
  if (rawOutputFallback) fallbackContent = [rawOutputFallback];
  const persistedOrFallback = toolCall.content.length > 0 ? toolCall.content : fallbackContent;
  const displayContent = lazyContent ?? persistedOrFallback;

  const handleToggle = async () => {
    if (!hasContent) return;

    if (!expanded && needsLazyLoad && !lazyContent && !loadFailed) {
      setExpanded(true);
      setLoading(true);
      setLoadFailed(false);
      try {
        const content = await onLoadContent!(toolCall.messageId!);
        setLazyContent(content);
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    } else {
      setExpanded(!expanded);
    }
  };

  return (
    <div className={`my-2 border overflow-hidden ${className ?? 'border-gray-200 rounded-lg'}`}>
      {/* Header — uses div with role="button" to allow nested interactive elements */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleToggle}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && hasContent) { e.preventDefault(); void handleToggle(); } }}
        aria-expanded={hasContent ? expanded : undefined}
        className={`w-full flex items-center gap-2 px-3 py-2 bg-gray-50 text-left ${hasContent ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="shrink-0"><StatusIcon status={toolCall.status} /></span>
          <span className="text-sm font-medium text-gray-700 truncate">{toolCall.title}</span>
          {toolCall.toolKind && (
            <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded shrink-0">
              {toolCall.toolKind}
            </span>
          )}
          {toolCall.locations.length > 0 && (
            onFileClick ? (
              <button
                type="button"
                className="text-xs text-blue-600 hover:text-blue-800 font-mono truncate min-w-0 bg-transparent border-none cursor-pointer p-0 text-left underline decoration-dotted"
                title={`${toolCall.locations[0]?.path}${toolCall.locations[0]?.line ? `:${toolCall.locations[0].line}` : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  const loc = toolCall.locations[0];
                  if (loc) onFileClick(loc.path, loc.line);
                }}
              >
                {toolCall.locations[0]?.path}{toolCall.locations[0]?.line ? `:${toolCall.locations[0].line}` : ''}
              </button>
            ) : (
              <span
                className="text-xs text-gray-500 font-mono truncate min-w-0"
                title={`${toolCall.locations[0]?.path}${toolCall.locations[0]?.line ? `:${toolCall.locations[0].line}` : ''}`}
              >
                {toolCall.locations[0]?.path}{toolCall.locations[0]?.line ? `:${toolCall.locations[0].line}` : ''}
              </span>
            )
          )}
        </div>
        {needsLazyLoad && !lazyContent && toolCall.contentSize != null && (
          <span className="text-xs text-gray-400 shrink-0">
            {formatBytes(toolCall.contentSize)}
          </span>
        )}
        {hasContent && (
          <svg
            className={`h-4 w-4 text-gray-400 transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </div>

      {/* Content */}
      {expanded && hasContent && (
        <div className="border-t border-gray-200">
          {loading ? (
            <div role="status" aria-live="polite" aria-label="Loading tool content" className="p-3 text-xs text-gray-500 animate-pulse">Loading content…</div>
          ) : loadFailed ? (
            <div role="alert" aria-live="assertive" className="p-3 text-xs text-red-600 flex items-center gap-1.5">
              <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              Failed to load content.
            </div>
          ) : displayContent.length === 0 ? (
            <div className="p-3 text-xs text-gray-500">No output.</div>
          ) : (
            displayContent.map((content, idx) => (
              <ToolCallContentView key={idx} content={content} />
            ))
          )}
        </div>
      )}
    </div>
  );
});

function ToolCallContentView({ content }: { content: ToolCallContentItem }) {
  const fallbackJson = getRenderableFallback(content.data);

  switch (content.type) {
    case 'diff':
      return content.text?.trim()
        ? <FileDiffView diff={content.text} />
        : fallbackJson;
    case 'terminal':
      return content.text?.trim()
        ? <TerminalBlock output={content.text} />
        : fallbackJson;
    case 'content':
    default:
      return content.text?.trim() ? (
        <div className="p-3 text-gray-700 whitespace-pre-wrap font-mono text-xs break-words overflow-hidden">
          {content.text}
        </div>
      ) : fallbackJson;
  }
}

function hasRenderableContent(content: ToolCallContentItem): boolean {
  if (content.text?.trim()) {
    return true;
  }

  if (content.data === null || content.data === undefined) {
    return false;
  }

  if (typeof content.data === 'string') {
    return content.data.trim().length > 0;
  }

  if (typeof content.data === 'number' || typeof content.data === 'boolean') {
    return true;
  }

  if (Array.isArray(content.data)) {
    return content.data.length > 0;
  }

  if (isJsonRecord(content.data)) {
    return Object.keys(content.data).length > 0;
  }

  return false;
}

function getRenderableFallback(data: unknown): React.JSX.Element | null {
  if (data === null || data === undefined) {
    return null;
  }

  const json = safeStringify(data);
  if (!json) {
    return null;
  }

  return (
    <pre className="p-3 text-xs text-gray-600 font-mono whitespace-pre-wrap overflow-auto max-h-40">
      {json}
    </pre>
  );
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') {
      return value;
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
