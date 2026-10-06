import { Spinner } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Image,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  downloadSessionFile,
  type FileEntry,
  getSessionFileContent,
  getSessionFileIndex,
  getSessionFileList,
  getSessionFileRawUrl,
  getSessionGitDiff,
  getSessionGitStatus,
  type GitStatusData,
} from '../../lib/api';
import { detectLanguage, formatFileSize, isImageFile } from '../../lib/file-utils';
import { fuzzyFilterFiles } from '../../lib/fuzzy-match';
import { CODE_THEME_BG, RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import { DiffRenderer, ImageViewer } from '../shared-file-viewer';
import { GitStatusList, HighlightedFilePath } from './chat-file-panel-rows';
import { buildBreadcrumbs, isMarkdownFile } from './chat-file-panel-utils';

export type FilePanelMode = 'browse' | 'view' | 'diff' | 'git-status';

interface ChatFilePanelProps {
  projectId: string;
  sessionId: string;
  initialMode: FilePanelMode;
  initialPath?: string;
  onClose: () => void;
}

export const ChatFilePanel: FC<ChatFilePanelProps> = ({
  projectId,
  sessionId,
  initialMode,
  initialPath,
  onClose,
}) => {
  const [mode, setMode] = useState<FilePanelMode>(initialMode);
  const [currentPath, setCurrentPath] = useState(initialPath ?? '.');
  const [filePath, setFilePath] = useState(initialPath ?? '');

  // Track previous list mode so back returns to git-status when appropriate
  const previousModeRef = useRef<'browse' | 'git-status'>(
    initialMode === 'git-status' ? 'git-status' : 'browse'
  );

  // File browser state
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // File viewer state
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  // Git status state
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);

  // Diff state
  const [diffContent, setDiffContent] = useState<string>('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  // Markdown rendering mode
  const [mdMode, setMdMode] = useState<'rendered' | 'source'>('rendered');

  // File search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [fileIndex, setFileIndex] = useState<string[] | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [fileIndexError, setFileIndexError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus management — move focus into panel on mount
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Ref to hold the latest activateSearch so the keydown effect avoids stale closures
  const activateSearchRef = useRef<() => void>(() => {});

  // Escape key closes panel or search; Cmd+P/Ctrl+P opens search
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchActive) {
          setSearchActive(false);
          setSearchQuery('');
        } else {
          onClose();
        }
      }
      // Cmd+P / Ctrl+P opens search when in browse mode
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === 'p' &&
        (mode === 'browse' || mode === 'git-status')
      ) {
        e.preventDefault();
        activateSearchRef.current();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, searchActive, mode]);

  // Load file listing
  const loadListing = useCallback(
    async (path: string) => {
      setBrowseLoading(true);
      setBrowseError(null);
      try {
        const result = await getSessionFileList(projectId, sessionId, path);
        setEntries(result.entries);
        setCurrentPath(result.path);
      } catch (err) {
        setBrowseError(err instanceof Error ? err.message : 'Failed to list directory');
      } finally {
        setBrowseLoading(false);
      }
    },
    [projectId, sessionId]
  );

  // Load file content
  const loadFile = useCallback(
    async (path: string) => {
      setFileLoading(true);
      setFileError(null);
      setFileContent(null);
      try {
        const result = await getSessionFileContent(projectId, sessionId, path);
        setFileContent(result.content);
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Failed to load file');
      } finally {
        setFileLoading(false);
      }
    },
    [projectId, sessionId]
  );

  // Load git status
  const loadGitStatus = useCallback(async () => {
    setGitLoading(true);
    setGitError(null);
    try {
      const result = await getSessionGitStatus(projectId, sessionId);
      setGitStatus(result);
    } catch (err) {
      setGitError(err instanceof Error ? err.message : 'Failed to load git status');
    } finally {
      setGitLoading(false);
    }
  }, [projectId, sessionId]);

  // Load diff
  const loadDiff = useCallback(
    async (path: string, staged = false) => {
      setDiffLoading(true);
      setDiffError(null);
      setDiffContent('');
      try {
        const result = await getSessionGitDiff(projectId, sessionId, path, staged);
        setDiffContent(result.diff);
      } catch (err) {
        setDiffError(err instanceof Error ? err.message : 'Failed to load diff');
      } finally {
        setDiffLoading(false);
      }
    },
    [projectId, sessionId]
  );

  // Load file index for search (cached — only fetched once per panel open)
  const loadFileIndex = useCallback(async () => {
    if (fileIndex !== null || fileIndexLoading) return;
    setFileIndexLoading(true);
    setFileIndexError(null);
    try {
      const files = await getSessionFileIndex(projectId, sessionId);
      setFileIndex(files);
    } catch (err) {
      setFileIndexError(err instanceof Error ? err.message : 'Failed to load file index');
    } finally {
      setFileIndexLoading(false);
    }
  }, [projectId, sessionId, fileIndex, fileIndexLoading]);

  // Activate search — loads file index on first activation, focuses input
  const activateSearch = useCallback(() => {
    setSearchActive(true);
    loadFileIndex();
    // Focus the input after React renders it
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [loadFileIndex]);

  // Keep the ref up-to-date so the keydown handler always calls the latest version
  activateSearchRef.current = activateSearch;

  // Compute search results from query and file index
  const searchResults = useMemo(
    () => (fileIndex && searchQuery.trim() ? fuzzyFilterFiles(fileIndex, searchQuery) : []),
    [fileIndex, searchQuery]
  );

  // Initial load based on mode. Mount-only: every mode-changing handler below
  // (navigateDir/openFile/openDiff/goBack, and the browse/git-status shortcuts
  // in the header) already triggers its own load imperatively in the same
  // tick that it calls setMode, so re-running this effect on mode/path
  // changes would double-fetch every navigation (and races two overlapping
  // requests toggling the same loading flag). This effect exists solely to
  // cover the initial mount, before any handler has run.
  useEffect(() => {
    if (mode === 'browse') loadListing(currentPath);
    else if (mode === 'view' && filePath && !isImageFile(filePath)) loadFile(filePath);
    else if (mode === 'git-status') loadGitStatus();
    else if (mode === 'diff' && filePath) loadDiff(filePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-only load; see comment above
  }, []);

  const navigateDir = (path: string) => {
    setCurrentPath(path);
    setMode('browse');
    loadListing(path);
  };

  const openFile = (path: string) => {
    if (mode === 'browse' || mode === 'git-status') {
      previousModeRef.current = mode;
    }
    setFilePath(path);
    setMode('view');
    // Image files are rendered via <img src> — skip text content fetch
    if (!isImageFile(path)) {
      loadFile(path);
    }
  };

  const openDiff = (path: string, staged = false) => {
    if (mode === 'browse' || mode === 'git-status') {
      previousModeRef.current = mode;
    }
    setFilePath(path);
    setMode('diff');
    loadDiff(path, staged);
  };

  const goBack = () => {
    if (mode === 'view' || mode === 'diff') {
      const target = previousModeRef.current;
      setMode(target);
      setSearchActive(false);
      setSearchQuery('');
      if (target === 'git-status') {
        loadGitStatus();
      } else {
        loadListing(currentPath);
      }
    } else {
      onClose();
    }
  };

  const handleEntryClick = (entry: FileEntry) => {
    const fullPath = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`;
    if (entry.type === 'dir') navigateDir(fullPath);
    else openFile(fullPath);
  };

  const fileName = filePath.split('/').pop() ?? filePath;
  const isMd = isMarkdownFile(filePath);
  const language = detectLanguage(filePath);

  return createPortal(
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,50vw)]
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(34,197,94,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="File viewer"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          {(mode === 'view' || mode === 'diff') && (
            <button
              type="button"
              onClick={goBack}
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
            <div className="flex gap-1 shrink-0">
              <button
                type="button"
                aria-pressed={mode === 'browse'}
                onClick={() => {
                  previousModeRef.current = 'browse';
                  setMode('browse');
                  loadListing(currentPath);
                }}
                className={`text-xs px-2 py-1 rounded border-none cursor-pointer ${mode === 'browse' ? 'bg-accent-primary text-fg-on-accent' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
              >
                Files
              </button>
              <button
                type="button"
                aria-pressed={mode === 'git-status'}
                onClick={() => {
                  previousModeRef.current = 'git-status';
                  setMode('git-status');
                  loadGitStatus();
                }}
                className={`text-xs px-2 py-1 rounded border-none cursor-pointer ${mode === 'git-status' ? 'bg-accent-primary text-fg-on-accent' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
              >
                Git
              </button>
            </div>
          )}

          {/* Markdown rendered/source toggle */}
          {mode === 'view' && isMd && !isImageFile(filePath) && (
            <div className="flex rounded-md overflow-hidden border border-border-default shrink-0">
              <button
                type="button"
                onClick={() => setMdMode('rendered')}
                className={`text-[11px] font-semibold px-2 py-1 border-none cursor-pointer ${mdMode === 'rendered' ? 'bg-info-tint text-fg-primary' : 'bg-transparent text-fg-muted'}`}
              >
                Rendered
              </button>
              <button
                type="button"
                onClick={() => setMdMode('source')}
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
                onClick={activateSearch}
                aria-label="Search files"
                title="Search files (Cmd/Ctrl+P)"
                className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
              >
                <Search size={14} />
              </button>
              <button
                type="button"
                onClick={() => loadListing(currentPath)}
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
            <button
              type="button"
              onClick={async () => {
                try {
                  const { blob, fileName: dlName } = await downloadSessionFile(
                    projectId,
                    sessionId,
                    filePath
                  );
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = dlName;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  console.error('Download failed:', err);
                }
              }}
              aria-label="Download file"
              className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
            >
              <Download size={14} />
            </button>
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

        {/* Breadcrumbs (browse mode) */}
        {mode === 'browse' && (
          <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border-default overflow-x-auto shrink-0">
            {buildBreadcrumbs(currentPath).map((crumb, idx, arr) => (
              <span key={crumb.path} className="flex items-center shrink-0">
                {idx > 0 && <ChevronRight size={12} className="text-fg-muted mx-0.5" />}
                <button
                  type="button"
                  onClick={() => navigateDir(crumb.path)}
                  className={`bg-transparent border-none cursor-pointer px-1 py-0.5 rounded text-xs font-mono
                    ${idx === arr.length - 1 ? 'text-fg-primary font-semibold' : 'text-fg-muted hover:text-fg-primary'}`}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search bar (browse mode, when active) */}
        {mode === 'browse' && searchActive && (
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0">
            <Search size={14} className="text-fg-muted shrink-0" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files by name..."
              aria-label="Search files"
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs font-mono text-fg-primary placeholder:text-fg-muted"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearchActive(false);
                  setSearchQuery('');
                }
                if (e.key === 'Enter') {
                  const firstResult = searchResults[0];
                  if (firstResult) {
                    openFile(firstResult.path);
                    setSearchActive(false);
                    setSearchQuery('');
                  }
                }
              }}
            />
            {fileIndexLoading && <Spinner size="sm" />}
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  searchInputRef.current?.focus();
                }}
                aria-label="Clear search"
                className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        {/* Content area */}
        <div className="flex-1 overflow-auto min-h-0 bg-canvas">
          {/* Browse mode — search results or directory listing */}
          {mode === 'browse' && searchActive && searchQuery.trim() && (
            <>
              {fileIndexError && (
                <div
                  className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
                  style={{ color: 'var(--sam-color-tn-red)' }}
                >
                  {fileIndexError}
                </div>
              )}
              {!fileIndexError && searchResults.length === 0 && fileIndex !== null && (
                <div className="flex justify-center p-12 text-fg-muted text-sm">
                  No files matching &ldquo;{searchQuery}&rdquo;
                </div>
              )}
              {searchResults.length > 0 && (
                <div>
                  {searchResults.map((result) => (
                    <button
                      key={result.path}
                      type="button"
                      aria-label={`Open ${result.path}`}
                      onClick={() => {
                        openFile(result.path);
                        setSearchActive(false);
                        setSearchQuery('');
                      }}
                      className="w-full flex items-center gap-2.5 px-4 py-2 min-h-[44px] text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover"
                    >
                      {isImageFile(result.path) ? (
                        <Image
                          size={14}
                          className="shrink-0"
                          style={{ color: 'var(--sam-color-info, #3b82f6)' }}
                        />
                      ) : (
                        <FileText size={14} className="shrink-0 text-fg-muted" />
                      )}
                      <span className="flex flex-col min-w-0 flex-1">
                        <HighlightedFilePath path={result.path} matches={result.matches} />
                        <span className="text-[10px] text-fg-muted truncate">{result.path}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Browse mode — normal directory listing (when not searching) */}
          {mode === 'browse' && !(searchActive && searchQuery.trim()) && (
            <>
              {browseLoading && entries.length === 0 && (
                <div className="flex justify-center p-8">
                  <Spinner size="md" />
                </div>
              )}
              {browseError && (
                <div
                  className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
                  style={{ color: 'var(--sam-color-tn-red)' }}
                >
                  {browseError}
                </div>
              )}
              {!browseError && entries.length === 0 && !browseLoading && (
                <div className="flex justify-center p-12 text-fg-muted text-sm">
                  This directory is empty
                </div>
              )}
              {entries.length > 0 && (
                <div style={{ opacity: browseLoading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                  {entries.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => handleEntryClick(entry)}
                      className="w-full flex items-center gap-2.5 px-4 py-2 min-h-[44px] text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover"
                    >
                      {entry.type === 'dir' ? (
                        <Folder
                          size={14}
                          className="shrink-0"
                          style={{ color: 'var(--sam-color-accent-primary)' }}
                        />
                      ) : isImageFile(entry.name) ? (
                        <Image
                          size={14}
                          className="shrink-0"
                          style={{ color: 'var(--sam-color-info, #3b82f6)' }}
                        />
                      ) : (
                        <FileText size={14} className="shrink-0 text-fg-muted" />
                      )}
                      <span className="text-xs font-mono text-fg-primary truncate flex-1 min-w-0">
                        {entry.name}
                        {entry.type === 'dir' ? '/' : ''}
                      </span>
                      {entry.type !== 'dir' && entry.size > 0 && (
                        <span className="text-[11px] font-mono text-fg-muted shrink-0">
                          {formatFileSize(entry.size)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* View mode */}
          {mode === 'view' && isImageFile(filePath) && (
            <ImageViewer
              src={getSessionFileRawUrl(projectId, sessionId, filePath)}
              fileName={fileName}
            />
          )}
          {mode === 'view' && !isImageFile(filePath) && (
            <>
              {fileLoading && (
                <div className="flex justify-center p-8">
                  <Spinner size="md" />
                </div>
              )}
              {fileError && (
                <div
                  className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
                  style={{ color: 'var(--sam-color-tn-red)' }}
                >
                  {fileError}
                </div>
              )}
              {!fileLoading &&
                !fileError &&
                fileContent !== null &&
                (isMd && mdMode === 'rendered' ? (
                  <RenderedMarkdown content={fileContent} />
                ) : (
                  <div className="min-h-full" style={{ backgroundColor: CODE_THEME_BG }}>
                    <SyntaxHighlightedCode content={fileContent} language={language} />
                  </div>
                ))}
            </>
          )}

          {/* Git status mode */}
          {mode === 'git-status' && (
            <>
              {gitLoading && (
                <div className="flex justify-center p-8">
                  <Spinner size="md" />
                </div>
              )}
              {gitError && (
                <div
                  className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
                  style={{ color: 'var(--sam-color-tn-red)' }}
                >
                  {gitError}
                </div>
              )}
              {!gitLoading && !gitError && gitStatus && (
                <GitStatusList status={gitStatus} onViewDiff={openDiff} onViewFile={openFile} />
              )}
              {!gitLoading &&
                !gitError &&
                gitStatus &&
                gitStatus.staged.length === 0 &&
                gitStatus.unstaged.length === 0 &&
                gitStatus.untracked.length === 0 && (
                  <div className="flex justify-center p-12 text-fg-muted text-sm">
                    No changes detected
                  </div>
                )}
            </>
          )}

          {/* Diff mode */}
          {mode === 'diff' && (
            <>
              {diffLoading && (
                <div className="flex justify-center p-8">
                  <Spinner size="md" />
                </div>
              )}
              {diffError && (
                <div
                  className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
                  style={{ color: 'var(--sam-color-tn-red)' }}
                >
                  {diffError}
                </div>
              )}
              {!diffLoading && !diffError && diffContent === '' && (
                <div className="flex justify-center p-12 text-fg-muted text-sm">
                  No diff available
                </div>
              )}
              {!diffLoading && !diffError && diffContent !== '' && (
                <DiffRenderer diff={diffContent} />
              )}
            </>
          )}
        </div>
      </div>
    </>,
    document.body
  );
};
