import type { NodeContainerLogTarget, NodeLogEntry } from '@simple-agent-manager/shared';
import { Alert } from '@simple-agent-manager/ui';
import { Clipboard, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';

import { formatLogTimestamp, formatReason } from './deployment-card-format';

export type DeploymentLogState = {
  entries: NodeLogEntry[];
  loading: boolean;
  error: string | null;
  unavailableReason?: string;
  containers?: NodeContainerLogTarget[];
};

const LOG_SOURCES = ['all', 'deployment-agent', 'app'] as const;
const LOG_LEVELS = ['all', 'error', 'warn', 'info', 'debug'] as const;

interface LogsPanelProps {
  state: DeploymentLogState | undefined;
  onRefresh: () => void;
  onRefreshFiltered: (opts: {
    source?: string;
    level?: string;
    search?: string;
    container?: string;
  }) => void;
}

export function LogsPanel({ state, onRefresh, onRefreshFiltered }: LogsPanelProps) {
  const [source, setSource] = useState<string>('all');
  const [level, setLevel] = useState<string>('all');
  const [container, setContainer] = useState('');
  const [search, setSearch] = useState('');

  const applyFilters = (nextSource?: string, nextLevel?: string, nextContainer?: string) => {
    const s = nextSource ?? source;
    const l = nextLevel ?? level;
    const c = nextContainer ?? container;
    const apiSource = s === 'app' ? 'docker' : s === 'deployment-agent' ? 'agent' : s;
    onRefreshFiltered({
      source: apiSource === 'all' ? undefined : apiSource,
      level: l === 'all' ? undefined : l,
      container: c || undefined,
      search: search.trim() || undefined,
    });
  };

  const handleCopyLogs = () => {
    if (!state?.entries.length) return;
    const text = state.entries
      .map((e) => `${e.timestamp} [${e.level}] [${e.source}] ${e.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text);
  };

  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="m-0 text-sm font-semibold text-fg-primary">Deployment Logs</h3>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleCopyLogs}
            disabled={!state?.entries.length}
            title="Copy recent logs to clipboard"
            className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-transparent px-2 py-1 text-xs text-fg-muted cursor-pointer hover:text-fg-primary disabled:opacity-40 disabled:cursor-default"
          >
            <Clipboard size={12} />
            Copy
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded-sm border border-border-default bg-transparent px-2 py-1 text-xs text-fg-muted cursor-pointer hover:text-fg-primary"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <label
            className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
            htmlFor="log-source"
          >
            Source
          </label>
          <select
            id="log-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              applyFilters(e.target.value, undefined);
            }}
            className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5"
          >
            {LOG_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <label
            className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
            htmlFor="log-level"
          >
            Level
          </label>
          <select
            id="log-level"
            value={level}
            onChange={(e) => {
              setLevel(e.target.value);
              applyFilters(undefined, e.target.value);
            }}
            className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5"
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        {(source === 'app' || source === 'all') && (
          <div className="flex items-center gap-1.5">
            <label
              className="text-[0.6875rem] uppercase text-fg-muted font-semibold"
              htmlFor="log-container"
            >
              Container
            </label>
            <select
              id="log-container"
              value={container}
              onChange={(e) => {
                setContainer(e.target.value);
                applyFilters(undefined, undefined, e.target.value);
              }}
              className="rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5 max-w-[180px]"
            >
              <option value="">All containers</option>
              {(state?.containers ?? []).map((target) => (
                <option key={target.name} value={target.name}>
                  {target.name}
                </option>
              ))}
              {container &&
                !(state?.containers ?? []).some((target) => target.name === container) && (
                  <option value={container}>{container}</option>
                )}
            </select>
          </div>
        )}
        <div className="flex items-center gap-1.5 flex-1 min-w-[120px]">
          <Search size={12} className="text-fg-muted shrink-0" />
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyFilters();
            }}
            className="w-full rounded-sm border border-border-default bg-inset text-fg-primary text-xs px-1.5 py-0.5 outline-none focus:border-accent"
          />
        </div>
      </div>

      <LogEntries state={state} />
    </section>
  );
}

function LogEntries({ state }: { state: DeploymentLogState | undefined }) {
  if (!state) return null;
  if (state.loading) {
    return <div className="text-xs text-fg-muted">Loading logs...</div>;
  }
  if (state.error) {
    return <Alert variant="error">{state.error}</Alert>;
  }
  if (state.entries.length === 0) {
    return (
      <div className="rounded-sm border border-border-default bg-inset px-3 py-2 text-xs text-fg-muted">
        {formatReason(state.unavailableReason)}
      </div>
    );
  }

  return (
    <div className="grid gap-1">
      <div className="text-[0.6875rem] text-fg-muted">
        Showing {state.entries.length} fetched log entr{state.entries.length === 1 ? 'y' : 'ies'}
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border border-border-default bg-inset font-mono text-xs">
        {state.entries.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${index}`}
            className="grid gap-0.5 px-2 py-1 border-b border-border-default last:border-b-0"
          >
            <div className="flex items-center gap-2 text-fg-muted flex-wrap">
              <span className="tabular-nums">{formatLogTimestamp(entry.timestamp)}</span>
              <span className="uppercase font-semibold">{entry.level}</span>
              <span className="truncate max-w-[120px]">{entry.source}</span>
            </div>
            <div className="text-fg-primary break-words overflow-hidden">{entry.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
