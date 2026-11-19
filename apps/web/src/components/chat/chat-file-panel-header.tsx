import { ArrowLeft, RefreshCw, Search, X } from 'lucide-react';

import { isImageFile } from '../../lib/file-utils';
import { DownloadFileButton, type FileDownloadError } from './chat-file-panel-download';
import type { FilePanelMode } from './ChatFilePanel';

/**
 * The file panel's title row: back, title, the Files / Git switch (a SAM Glass segmented
 * well), the markdown rendered/source toggle, search, refresh, download and close. Split out
 * of `ChatFilePanel` to keep that file within the size limit (rule 18); it holds no state.
 */
export function ChatFilePanelHeader({
  mode,
  fileName,
  filePath,
  isMarkdown,
  mdMode,
  onMdModeChange,
  onBack,
  onShowFiles,
  onShowGit,
  onSearch,
  onRefresh,
  browseLoading,
  projectId,
  sessionId,
  onDownloadError,
  onClose,
}: Readonly<{
  mode: FilePanelMode;
  fileName: string;
  filePath: string;
  isMarkdown: boolean;
  mdMode: 'rendered' | 'source';
  onMdModeChange: (mode: 'rendered' | 'source') => void;
  onBack: () => void;
  onShowFiles: () => void;
  onShowGit: () => void;
  onSearch: () => void;
  onRefresh: () => void;
  browseLoading: boolean;
  projectId: string;
  sessionId: string;
  onDownloadError: (error: FileDownloadError | null) => void;
  onClose: () => void;
}>) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--sam-hairline)] px-3 py-2">
      {(mode === 'view' || mode === 'diff') && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
        >
          <ArrowLeft size={16} />
        </button>
      )}

      <span className="text-sm font-medium text-fg-primary truncate flex-1 min-w-0 font-mono">
        {mode === 'browse' && 'Files'}
        {mode === 'git-status' && 'Git Changes'}
        {mode === 'view' && fileName}
        {mode === 'diff' && `Diff: ${fileName}`}
      </span>

      {/* Mode toggle for git-status → browse */}
      {(mode === 'browse' || mode === 'git-status') && (
        <div className="sam-well flex shrink-0 gap-0.5 rounded-[var(--sam-radius-control)] p-0.5">
          <button
            type="button"
            aria-pressed={mode === 'browse'}
            onClick={onShowFiles}
            className={`h-8 cursor-pointer rounded-[9px] border-none px-3 text-[13px] ${mode === 'browse' ? 'sam-raised font-medium text-fg-primary' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
          >
            Files
          </button>
          <button
            type="button"
            aria-pressed={mode === 'git-status'}
            onClick={onShowGit}
            className={`h-8 cursor-pointer rounded-[9px] border-none px-3 text-[13px] ${mode === 'git-status' ? 'sam-raised font-medium text-fg-primary' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
          >
            Git
          </button>
        </div>
      )}

      {/* Markdown rendered/source toggle */}
      {mode === 'view' && isMarkdown && !isImageFile(filePath) && (
        <div className="flex rounded-md overflow-hidden border border-border-default shrink-0">
          <button
            type="button"
            onClick={() => onMdModeChange('rendered')}
            className={`text-[11px] font-semibold px-2 py-1 border-none cursor-pointer ${mdMode === 'rendered' ? 'bg-info-tint text-fg-primary' : 'bg-transparent text-fg-muted'}`}
          >
            Rendered
          </button>
          <button
            type="button"
            onClick={() => onMdModeChange('source')}
            className={`text-[11px] font-semibold px-2 py-1 border-none cursor-pointer ${mdMode === 'source' ? 'bg-info-tint text-fg-primary' : 'bg-transparent text-fg-muted'}`}
          >
            Source
          </button>
        </div>
      )}

      {mode === 'browse' && (
        <>
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search files"
            title="Search files (Cmd/Ctrl+P)"
            className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={browseLoading}
            aria-label="Refresh"
            className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
            style={{ opacity: browseLoading ? 0.5 : 1 }}
          >
            <RefreshCw size={14} className={browseLoading ? 'animate-spin' : ''} />
          </button>
        </>
      )}

      {mode === 'view' && filePath && (
        <DownloadFileButton
          projectId={projectId}
          sessionId={sessionId}
          filePath={filePath}
          onError={onDownloadError}
        />
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label="Close file panel"
        className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
      >
        <X size={16} />
      </button>
    </header>
  );
}
