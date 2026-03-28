import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import {
  X, ChevronRight, Folder, FileText, Image, RefreshCw, ArrowLeft,
} from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { DiffRenderer, ImageViewer } from '../shared-file-viewer';
import { SyntaxHighlightedCode, RenderedMarkdown } from '../MarkdownRenderer';
import {
  getSessionFileList,
  getSessionFileContent,
  getSessionFileRawUrl,
  getSessionGitStatus,
  getSessionGitDiff,
  type FileEntry,
  type GitStatusData,
  type GitFileStatus,
} from '../../lib/api';
import { isImageFile } from '../../lib/file-utils';

export type FilePanelMode = 'browse' | 'view' | 'diff' | 'git-status';

interface ChatFilePanelProps {
  projectId: string;
  sessionId: string;
  initialMode: FilePanelMode;
  initialPath?: string;
  onClose: () => void;
}

// Map file extensions to Prism language identifiers
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  go: 'go', py: 'python', css: 'css', html: 'markup', htm: 'markup',
  json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', dockerfile: 'docker',
  toml: 'toml', sql: 'sql', rs: 'rust', rb: 'ruby', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', xml: 'markup', svg: 'markup',
  graphql: 'graphql', gql: 'graphql',
};

function detectLanguage(filePath: string): string {
  const filename = filePath.split('/').pop() ?? '';
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  if (lower === 'makefile') return 'makefile';
  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? '';
}

function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

interface BreadcrumbItem { label: string; path: string }

function buildBreadcrumbs(dirPath: string): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [{ label: '/', path: '.' }];
  if (dirPath === '.' || dirPath === '' || dirPath === '/') return crumbs;
  let normalized = dirPath;
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);
  const parts = normalized.split('/').filter(Boolean);
  let accumulated = '';
  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    crumbs.push({ label: part, path: accumulated });
  }
  return crumbs;
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

  // Focus management — move focus into panel on mount
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Escape key closes panel
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Load file listing
  const loadListing = useCallback(async (path: string) => {
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
  }, [projectId, sessionId]);

  // Load file content
  const loadFile = useCallback(async (path: string) => {
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
  }, [projectId, sessionId]);

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
  const loadDiff = useCallback(async (path: string, staged = false) => {
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
  }, [projectId, sessionId]);

  // Initial load based on mode
  useEffect(() => {
    if (mode === 'browse') loadListing(currentPath);
    else if (mode === 'view' && filePath && !isImageFile(filePath)) loadFile(filePath);
    else if (mode === 'git-status') loadGitStatus();
    else if (mode === 'diff' && filePath) loadDiff(filePath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const navigateDir = (path: string) => {
    setCurrentPath(path);
    setMode('browse');
    loadListing(path);
  };

  const openFile = (path: string) => {
    setFilePath(path);
    setMode('view');
    // Image files are rendered via <img src> — skip text content fetch
    if (!isImageFile(path)) {
      loadFile(path);
    }
  };

  const openDiff = (path: string, staged = false) => {
    setFilePath(path);
    setMode('diff');
    loadDiff(path, staged);
  };

  const goBack = () => {
    if (mode === 'view' || mode === 'diff') {
      setMode('browse');
      loadListing(currentPath);
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

  return (
    <>
      {/* Backdrop — visible only on desktop */}
      <div
        className="hidden md:block fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        className="fixed z-50 bg-canvas flex flex-col shadow-xl
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[min(560px,50vw)]
          md:border-l md:border-border-default"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="File viewer"
      >
        {/* Header */}
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default bg-surface shrink-0 min-h-[44px]">
          {(mode === 'view' || mode === 'diff') && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
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
                onClick={() => { setMode('browse'); loadListing(currentPath); }}
                className={`text-xs px-2 py-1 rounded border-none cursor-pointer ${mode === 'browse' ? 'bg-accent-primary text-fg-on-accent' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
              >
                Files
              </button>
              <button
                type="button"
                aria-pressed={mode === 'git-status'}
                onClick={() => { setMode('git-status'); loadGitStatus(); }}
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
            <button
              type="button"
              onClick={() => loadListing(currentPath)}
              disabled={browseLoading}
              aria-label="Refresh"
              className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
              style={{ opacity: browseLoading ? 0.5 : 1 }}
            >
              <RefreshCw size={14} className={browseLoading ? 'animate-spin' : ''} />
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label="Close file panel"
            className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
          >
            <X size={16} />
          </button>
        </header>

        {/* Breadcrumbs (browse mode) */}
        {mode === 'browse' && (
          <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-border-default bg-surface overflow-x-auto shrink-0">
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

        {/* Content area */}
        <div className="flex-1 overflow-auto min-h-0">
          {/* Browse mode */}
          {mode === 'browse' && (
            <>
              {browseLoading && entries.length === 0 && (
                <div className="flex justify-center p-8"><Spinner size="md" /></div>
              )}
              {browseError && (
                <div className="m-4 p-3 bg-danger-tint rounded-lg text-xs" style={{ color: 'var(--sam-color-tn-red)' }}>
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
                      className="w-full flex items-center gap-2.5 px-4 py-2 min-h-[40px] text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover"
                    >
                      {entry.type === 'dir' ? (
                        <Folder size={14} className="shrink-0" style={{ color: 'var(--sam-color-accent-primary)' }} />
                      ) : isImageFile(entry.name) ? (
                        <Image size={14} className="shrink-0" style={{ color: 'var(--sam-color-info, #3b82f6)' }} />
                      ) : (
                        <FileText size={14} className="shrink-0 text-fg-muted" />
                      )}
                      <span className="text-xs font-mono text-fg-primary truncate flex-1 min-w-0">
                        {entry.name}{entry.type === 'dir' ? '/' : ''}
                      </span>
                      {entry.type !== 'dir' && entry.size > 0 && (
                        <span className="text-[11px] font-mono text-fg-muted shrink-0">
                          {formatSize(entry.size)}
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
                <div className="flex justify-center p-8"><Spinner size="md" /></div>
              )}
              {fileError && (
                <div className="m-4 p-3 bg-danger-tint rounded-lg text-xs" style={{ color: 'var(--sam-color-tn-red)' }}>
                  {fileError}
                </div>
              )}
              {!fileLoading && !fileError && fileContent !== null && (
                isMd && mdMode === 'rendered' ? (
                  <RenderedMarkdown content={fileContent} />
                ) : (
                  <SyntaxHighlightedCode content={fileContent} language={language} />
                )
              )}
            </>
          )}

          {/* Git status mode */}
          {mode === 'git-status' && (
            <>
              {gitLoading && (
                <div className="flex justify-center p-8"><Spinner size="md" /></div>
              )}
              {gitError && (
                <div className="m-4 p-3 bg-danger-tint rounded-lg text-xs" style={{ color: 'var(--sam-color-tn-red)' }}>
                  {gitError}
                </div>
              )}
              {!gitLoading && !gitError && gitStatus && (
                <GitStatusList
                  status={gitStatus}
                  onViewDiff={openDiff}
                  onViewFile={openFile}
                />
              )}
              {!gitLoading && !gitError && gitStatus &&
                gitStatus.staged.length === 0 && gitStatus.unstaged.length === 0 && gitStatus.untracked.length === 0 && (
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
                <div className="flex justify-center p-8"><Spinner size="md" /></div>
              )}
              {diffError && (
                <div className="m-4 p-3 bg-danger-tint rounded-lg text-xs" style={{ color: 'var(--sam-color-tn-red)' }}>
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
    </>
  );
};

// ---------- Git Status List sub-component ----------

function GitStatusList({
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
            <GitFileRow key={`staged-${file.path}`} file={file} onViewDiff={() => onViewDiff(file.path, true)} onViewFile={() => onViewFile(file.path)} />
          ))}
        </section>
      )}
      {status.unstaged.length > 0 && (
        <section className="py-2">
          <h4 className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            Unstaged ({status.unstaged.length})
          </h4>
          {status.unstaged.map((file) => (
            <GitFileRow key={`unstaged-${file.path}`} file={file} onViewDiff={() => onViewDiff(file.path, false)} onViewFile={() => onViewFile(file.path)} />
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
              className="w-full flex items-center gap-2 px-4 py-1.5 text-left bg-transparent border-none cursor-pointer hover:bg-surface-hover"
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
    file.status === 'added' || file.status === 'new file' ? 'var(--sam-color-tn-green)' :
    file.status === 'deleted' ? 'var(--sam-color-tn-red)' :
    'var(--sam-color-tn-yellow, var(--sam-color-warning, #f59e0b))';

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
        className="text-[10px] font-semibold px-2 py-1 rounded border border-border-default bg-transparent cursor-pointer text-fg-muted hover:text-fg-primary md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0"
      >
        Diff
      </button>
    </div>
  );
}
