import React, { useMemo, useState } from 'react';

import type { ToolCallContentItem, ToolCallGroupItem, ToolCallItem } from '../hooks/useAcpMessages';
import { ToolCallCard } from './ToolCallCard';

interface ToolCallGroupCardProps {
  group: ToolCallGroupItem;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
  /** Render a single call. Lets a host swap in its typed cards (e.g. DocumentCard). */
  renderCall?: (call: ToolCallItem) => React.ReactNode;
  /** Start expanded — used by the "expand all tool calls" preference. */
  defaultExpanded?: boolean;
  className?: string;
}

type RunStatus = 'running' | 'failed' | 'completed';

function runStatus(calls: ToolCallItem[]): RunStatus {
  if (calls.some((call) => call.status === 'pending' || call.status === 'in_progress')) {
    return 'running';
  }
  if (calls.some((call) => call.status === 'failed')) return 'failed';
  return 'completed';
}

function RunIcon({ status }: { status: RunStatus }) {
  if (status === 'running') {
    return (
      <div
        aria-hidden="true"
        className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-500 border-t-transparent"
      />
    );
  }
  if (status === 'failed') {
    return (
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5 text-red-500 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 opacity-60"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
    </svg>
  );
}

/** "Read, Bash and 2 more" — enough to recognise the run without reading it. */
function summarizeToolNames(calls: ToolCallItem[]): string {
  const seen: string[] = [];
  for (const call of calls) {
    const label = shortToolLabel(call);
    if (label && !seen.includes(label)) seen.push(label);
  }
  if (seen.length === 0) return '';
  if (seen.length <= 2) return seen.join(', ');
  return `${seen.slice(0, 2).join(', ')} and ${seen.length - 2} more`;
}

/**
 * The tool's short name.
 *
 * `toolName` is a qualified identifier (`mcp__sam-mcp__upload_to_library`), so
 * its LAST segment is the name. A `title` is human text (`"Read: src/a.ts"`,
 * `"Bash: pnpm test"`), so its FIRST token is. Taking the last segment of a
 * title yields the argument instead of the tool, which reads as "a.ts, b.ts"
 * where the user expects "Read".
 */
function shortToolLabel(call: ToolCallItem): string {
  if (call.toolName) {
    const segments = call.toolName.split(/__|\/|\.|:/).filter(Boolean);
    const last = segments[segments.length - 1] ?? call.toolName;
    return last.trim();
  }
  const firstToken = (call.title ?? '').trim().split(/[:\s]+/)[0] ?? '';
  return firstToken;
}

/**
 * Collapsed summary of a run of consecutive tool calls.
 *
 * Two opt-in levels, both closed by default: the card states the count, tapping
 * it reveals the list, and tapping a row loads that call's output. The count is
 * the point — a user who never expands still sees that work is happening.
 */
export const ToolCallGroupCard = React.memo(function ToolCallGroupCard({
  group,
  onFileClick,
  onLoadContent,
  renderCall,
  defaultExpanded = false,
  className,
}: ToolCallGroupCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const status = useMemo(() => runStatus(group.calls), [group.calls]);
  const names = useMemo(() => summarizeToolNames(group.calls), [group.calls]);

  const count = group.calls.length;
  const countLabel = `${count} tool ${count === 1 ? 'call' : 'calls'}`;
  const failedCount = group.calls.filter((call: ToolCallItem) => call.status === 'failed').length;

  return (
    <div
      className={`my-2 min-w-0 overflow-hidden rounded-lg border ${className ?? 'border-border-default'}`}
      data-testid="tool-call-group"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left hover:opacity-90"
      >
        <span
          aria-hidden="true"
          className={`shrink-0 text-xs transition-transform ${expanded ? 'rotate-90' : ''}`}
          style={{ color: 'var(--sam-color-fg-muted)' }}
        >
          ▸
        </span>
        <RunIcon status={status} />
        <span
          className="shrink-0 text-xs font-medium"
          style={{ color: 'var(--sam-color-fg-primary)' }}
        >
          {countLabel}
        </span>
        {names && (
          <span
            className="min-w-0 flex-1 truncate text-xs"
            style={{ color: 'var(--sam-color-fg-muted)' }}
          >
            {names}
          </span>
        )}
        {status === 'running' && (
          <span className="ml-auto shrink-0 text-xs" style={{ color: 'var(--sam-color-fg-muted)' }}>
            running
          </span>
        )}
        {failedCount > 0 && (
          <span className="ml-auto shrink-0 text-xs text-red-500">
            {failedCount} failed
          </span>
        )}
      </button>

      {expanded && (
        <div className="min-w-0 border-t border-border-default px-2 pb-1">
          {group.calls.map((call: ToolCallItem) => (
            <div key={call.id} className="min-w-0">
              {renderCall ? (
                renderCall(call)
              ) : (
                <ToolCallCard
                  toolCall={call}
                  onFileClick={onFileClick}
                  onLoadContent={onLoadContent}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
