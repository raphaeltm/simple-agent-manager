// File-tree/list row subcomponents for ChatFilePanel. Split out of
// ChatFilePanel.tsx (see .claude/rules/18-file-size-limits.md) — pure
// extraction, no behavior change.

import type { GitFileStatus, GitStatusData } from '../../lib/api';
import { fileNameFromPath } from '../../lib/fuzzy-match';

// ---------- Git Status List sub-component ----------

export function GitStatusList({
  status,
  onViewDiff,
  onViewFile,
}: {
  status: GitStatusData;
  onViewDiff: (path: string, staged: boolean) => void;
  onViewFile: (path: string) => void;
}) {
  return (
    <div className="divide-y divide-border-default">
      {status.staged.length > 0 && (
        <section className="py-2">
          <h4 className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Staged ({status.staged.length})
          </h4>
          {status.staged.map((file) => (
            <GitFileRow
              key={`staged-${file.path}`}
              file={file}
              onViewDiff={() => onViewDiff(file.path, true)}
              onViewFile={() => onViewFile(file.path)}
            />
          ))}
        </section>
      )}
      {status.unstaged.length > 0 && (
        <section className="py-2">
          <h4 className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Unstaged ({status.unstaged.length})
          </h4>
          {status.unstaged.map((file) => (
            <GitFileRow
              key={`unstaged-${file.path}`}
              file={file}
              onViewDiff={() => onViewDiff(file.path, false)}
              onViewFile={() => onViewFile(file.path)}
            />
          ))}
        </section>
      )}
      {status.untracked.length > 0 && (
        <section className="py-2">
          <h4 className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Untracked ({status.untracked.length})
          </h4>
          {status.untracked.map((file) => (
            <button
              key={`untracked-${file.path}`}
              type="button"
              onClick={() => onViewFile(file.path)}
              className="w-full flex items-center gap-2 px-4 py-1.5 min-h-[44px] text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover"
            >
              <span className="text-xs font-mono text-fg-muted">?</span>
              <span className="text-xs font-mono text-fg-primary truncate">{file.path}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

/** Renders a file name with fuzzy-matched characters highlighted. */
export function HighlightedFilePath({ path, matches }: { path: string; matches: number[] }) {
  const name = fileNameFromPath(path);
  const nameStart = path.length - name.length;
  const matchSet = new Set(matches);

  return (
    <span className="text-xs font-mono text-fg-primary truncate" aria-label={name}>
      {Array.from(name).map((char, i) => {
        const globalIdx = nameStart + i;
        const isMatch = matchSet.has(globalIdx);
        return isMatch ? (
          <span
            key={i}
            aria-hidden="true"
            className="font-bold"
            style={{ color: 'var(--sam-color-accent-primary)' }}
          >
            {char}
          </span>
        ) : (
          <span key={i} aria-hidden="true">
            {char}
          </span>
        );
      })}
    </span>
  );
}

function GitFileRow({
  file,
  onViewDiff,
  onViewFile,
}: {
  file: GitFileStatus;
  onViewDiff: () => void;
  onViewFile: () => void;
}) {
  const statusColor =
    file.status === 'added' || file.status === 'new file'
      ? 'var(--sam-color-tn-green)'
      : file.status === 'deleted'
        ? 'var(--sam-color-tn-red)'
        : 'var(--sam-color-tn-yellow, var(--sam-color-warning, #f59e0b))';

  const statusLabel = file.status.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-surface-hover group min-h-[44px]">
      <span
        className="text-xs font-mono font-semibold w-4 text-center shrink-0"
        style={{ color: statusColor }}
        title={file.status}
      >
        {statusLabel}
      </span>
      <button
        type="button"
        onClick={onViewFile}
        className="text-xs font-mono text-fg-primary truncate flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left p-0 hover:underline"
      >
        {file.path}
      </button>
      <button
        type="button"
        onClick={onViewDiff}
        className="text-[10px] font-semibold px-2 py-1 rounded border border-border-default bg-transparent cursor-pointer text-fg-muted hover:text-fg-primary md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--sam-color-focus-ring,#3b82f6)] focus-visible:ring-offset-1 transition-opacity shrink-0"
      >
        Diff
      </button>
    </div>
  );
}
