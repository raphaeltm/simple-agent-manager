import type { PlatformError } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Check, Copy } from 'lucide-react';
import { type FC, useCallback, useState } from 'react';

import { CopyableIdPill } from './CopyableIdPill';

export interface ObservabilityLogEntryProps {
  error: PlatformError;
  onDiagnose?: (error: PlatformError) => void;
  diagnosed?: boolean;
}

const DEFAULT_SOURCE_COLOR = {
  bg: 'var(--sam-color-warning-tint)',
  text: 'var(--sam-color-warning-fg)',
};
const DEFAULT_LEVEL_COLOR = {
  bg: 'var(--sam-color-danger-tint)',
  text: 'var(--sam-color-danger-fg)',
};

const SOURCE_COLORS: Record<string, { bg: string; text: string }> = {
  client: {
    bg: 'var(--sam-color-info-tint)',
    text: 'var(--sam-admin-chart-series-2, var(--sam-color-info-fg))',
  },
  'vm-agent': {
    bg: 'var(--sam-color-info-tint)',
    text: 'var(--sam-admin-chart-series-3, var(--sam-color-purple))',
  },
  api: DEFAULT_SOURCE_COLOR,
};

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  error: DEFAULT_LEVEL_COLOR,
  warn: { bg: 'var(--sam-color-warning-tint)', text: 'var(--sam-color-warning-fg)' },
  info: { bg: 'var(--sam-color-info-tint)', text: 'var(--sam-color-info-fg)' },
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function buildMarkdownReport(entry: PlatformError): string {
  // Plain markdown document — only stack and context are fenced, so the
  // report renders correctly when pasted (no nested-fence breakage).
  const lines: string[] = [`## SAM Error Report`, ''];
  lines.push(`**Timestamp:** ${entry.timestamp}`);
  lines.push(`**Source:** ${entry.source}`);
  lines.push(`**Level:** ${entry.level}`);
  lines.push(`**ID:** ${entry.id}`);
  lines.push('');
  lines.push(`**Message:**`);
  lines.push(entry.message);

  const ids: string[] = [];
  if (entry.userId) ids.push(`- User: ${entry.userId}`);
  if (entry.nodeId) ids.push(`- Node: ${entry.nodeId}`);
  if (entry.workspaceId) ids.push(`- Workspace: ${entry.workspaceId}`);
  if (entry.taskId) ids.push(`- Task: ${entry.taskId}`);
  if (entry.sessionId) ids.push(`- Session: ${entry.sessionId}`);
  if (ids.length > 0) {
    lines.push('');
    lines.push('**IDs:**');
    lines.push(...ids);
  }

  if (entry.stack) {
    lines.push('');
    lines.push('**Stack:**');
    lines.push('```');
    lines.push(entry.stack);
    lines.push('```');
  }

  if (entry.context) {
    lines.push('');
    lines.push('**Context:**');
    lines.push('```json');
    lines.push(JSON.stringify(entry.context, null, 2));
    lines.push('```');
  }

  if (entry.incident) {
    lines.push('');
    lines.push(`**Incident:** ${entry.incident.status}`);
    if (entry.incident.artifacts?.length) {
      lines.push(`  Artifacts: ${entry.incident.artifacts.length}`);
    }
  }

  return lines.join('\n');
}

function deriveProjectId(entry: PlatformError): string | null {
  const ctx = entry.context;
  if (!ctx) return null;
  if (typeof ctx.projectId === 'string' && ctx.projectId) return ctx.projectId;
  return null;
}

export const ObservabilityLogEntry: FC<ObservabilityLogEntryProps> = ({
  error: entry,
  onDiagnose,
  diagnosed,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [incidentExpanded, setIncidentExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const sourceColor = SOURCE_COLORS[entry.source] ?? DEFAULT_SOURCE_COLOR;
  const levelColor = LEVEL_COLORS[entry.level] ?? DEFAULT_LEVEL_COLOR;
  const hasDetails = entry.stack || entry.context;
  const projectId = deriveProjectId(entry);

  const handleCopyMarkdown = useCallback(() => {
    const text = buildMarkdownReport(entry);
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [entry]);

  return (
    <div
      data-testid="observability-log-entry"
      className="min-w-0 border-b border-border-default px-4 py-3 transition-colors duration-150"
    >
      {/* Main row */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-2 text-[0.7rem] font-semibold uppercase tracking-tight"
            style={{ backgroundColor: levelColor.bg, color: levelColor.text, padding: '1px 8px' }}
          >
            {entry.level}
          </span>
          <span
            className="inline-flex items-center rounded-full px-2 text-[0.7rem] font-semibold uppercase tracking-tight"
            style={{ backgroundColor: sourceColor.bg, color: sourceColor.text, padding: '1px 8px' }}
          >
            {entry.source}
          </span>
          {diagnosed && (
            <span
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[0.65rem] font-medium"
              style={{
                backgroundColor: 'var(--sam-color-success-tint)',
                color: 'var(--sam-color-success)',
              }}
            >
              diagnosed
            </span>
          )}
          {entry.incident && (
            <button
              type="button"
              className="inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent transition-colors cursor-pointer"
              aria-label={`Toggle incident details: ${entry.incident.status}`}
              aria-expanded={incidentExpanded}
              onClick={() => setIncidentExpanded(!incidentExpanded)}
            >
              evidence {entry.incident.status}
              <span
                aria-hidden="true"
                className="ml-1 text-[0.6rem] transition-transform duration-150"
                style={{ transform: incidentExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
            </button>
          )}
          <span className="min-w-0 text-xs text-fg-muted">{formatTimestamp(entry.timestamp)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end sm:ml-auto sm:self-auto">
          <button
            type="button"
            className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-sm text-fg-muted transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            aria-label={copied ? 'Copied error as markdown' : 'Copy error as markdown'}
            title="Copy as markdown"
            onClick={handleCopyMarkdown}
            data-testid="copy-markdown-btn"
          >
            {copied ? <Check size={14} style={{ color: 'var(--sam-color-success)' }} /> : <Copy size={14} />}
          </button>
          {onDiagnose && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onDiagnose(entry);
              }}
            >
              Diagnose
            </Button>
          )}
          {hasDetails && (
            <button
              type="button"
              className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-sm text-[0.7rem] text-fg-muted transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              aria-label={expanded ? 'Hide error details' : 'Show error details'}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              <span
                aria-hidden="true"
                className="transition-transform duration-150"
                style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                ▶
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Message */}
      <div className="mt-1 min-w-0 whitespace-normal break-words text-sm text-fg-primary">
        {entry.message}
      </div>

      {/* ID pills row */}
      <ErrorIdPills entry={entry} projectId={projectId} />

      {/* Incident details (expandable) */}
      {incidentExpanded && entry.incident && (
        <div className="mt-2 rounded-sm border border-border-default bg-surface p-3">
          <div className="text-xs font-medium text-fg-primary">Automatic VM evidence</div>
          <div className="mt-1 text-xs text-fg-muted">
            Status: {entry.incident.status}
            {entry.incident.createdAt && ` · Captured: ${formatTimestamp(entry.incident.createdAt)}`}
          </div>
          {entry.incident.artifacts && entry.incident.artifacts.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-fg-muted">
                {entry.incident.artifacts.length} artifact{entry.incident.artifacts.length !== 1 ? 's' : ''} available
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-3">
          {entry.stack && (
            <pre
              className="m-0 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-3 text-xs leading-normal text-fg-muted"
              style={{ maxHeight: 200 }}
            >
              {entry.stack}
            </pre>
          )}
          {entry.context && (
            <pre
              className="overflow-auto whitespace-pre-wrap break-all rounded-sm bg-inset p-3 text-xs leading-normal text-fg-muted"
              style={{ maxHeight: 200, margin: entry.stack ? 'var(--sam-space-2) 0 0' : 0 }}
            >
              {JSON.stringify(entry.context, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

const ErrorIdPills: FC<{ entry: PlatformError; projectId: string | null }> = ({
  entry,
  projectId,
}) => {
  const hasIds =
    entry.userId || entry.nodeId || entry.workspaceId || entry.taskId || entry.sessionId;
  if (!hasIds) return null;

  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
      {entry.userId && <CopyableIdPill label="user" value={entry.userId} />}
      {entry.nodeId && (
        <CopyableIdPill label="node" value={entry.nodeId} href={`/nodes/${entry.nodeId}`} />
      )}
      {entry.workspaceId && (
        <CopyableIdPill
          label="ws"
          value={entry.workspaceId}
          href={projectId ? `/projects/${projectId}/workspace/${entry.workspaceId}` : undefined}
        />
      )}
      {entry.taskId && (
        <CopyableIdPill
          label="task"
          value={entry.taskId}
          href={projectId ? `/projects/${projectId}` : undefined}
        />
      )}
      {entry.sessionId && (
        <CopyableIdPill
          label="session"
          value={entry.sessionId}
          href={projectId ? `/projects/${projectId}?sessionId=${entry.sessionId}` : undefined}
        />
      )}
    </div>
  );
};
