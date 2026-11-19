import { Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type FileEntry,
  getSessionFileContent,
  getSessionFileIndex,
  getSessionFileList,
  getSessionFileRawUrl,
  getSessionGitDiff,
  getSessionGitStatus,
  type GitStatusData,
} from '../../lib/api';
import { detectLanguage, isImageFile } from '../../lib/file-utils';
import { fuzzyFilterFiles } from '../../lib/fuzzy-match';
import { CODE_THEME_BG, RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import { DiffRenderer, ImageViewer } from '../shared-file-viewer';
import { GlassSheet } from '../shell/GlassSheet';
import {
  DirectoryListing,
  FileBreadcrumbs,
  FileSearchBar,
  FileSearchResults,
} from './chat-file-panel-browse';
import type { FileDownloadError } from './chat-file-panel-download';
import { ChatFilePanelHeader } from './chat-file-panel-header';
import { GitStatusList } from './chat-file-panel-rows';
import { isMarkdownFile } from './chat-file-panel-utils';

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
  // Cleared when a file is opened, and shown only for the file it is about.
  const [downloadError, setDownloadError] = useState<FileDownloadError | null>(null);

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
    setDownloadError(null);
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

  const openSearchResult = (path: string) => {
    openFile(path);
    setSearchActive(false);
    setSearchQuery('');
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
    <GlassSheet
      label="File viewer"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[min(560px,50vw)]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
    >
        {/* Header */}
        <ChatFilePanelHeader
          mode={mode}
          fileName={fileName}
          filePath={filePath}
          isMarkdown={isMd}
          mdMode={mdMode}
          onMdModeChange={setMdMode}
          onBack={goBack}
          onShowFiles={() => {
            previousModeRef.current = 'browse';
            setMode('browse');
            loadListing(currentPath);
          }}
          onShowGit={() => {
            previousModeRef.current = 'git-status';
            setMode('git-status');
            loadGitStatus();
          }}
          onSearch={activateSearch}
          onRefresh={() => loadListing(currentPath)}
          browseLoading={browseLoading}
          projectId={projectId}
          sessionId={sessionId}
          onDownloadError={setDownloadError}
          onClose={onClose}
        />

        {mode === 'browse' && <FileBreadcrumbs path={currentPath} onNavigate={navigateDir} />}

        {mode === 'browse' && searchActive && (
          <FileSearchBar
            inputRef={searchInputRef}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            loading={fileIndexLoading}
            onCancel={() => {
              setSearchActive(false);
              setSearchQuery('');
            }}
            onSubmit={() => {
              const firstResult = searchResults[0];
              if (firstResult) openSearchResult(firstResult.path);
            }}
          />
        )}

        {/* Content area */}
        <div className="flex-1 overflow-auto min-h-0 bg-canvas">
          {mode === 'browse' && searchActive && searchQuery.trim() && (
            <FileSearchResults
              results={searchResults}
              error={fileIndexError}
              indexLoaded={fileIndex !== null}
              query={searchQuery}
              onOpen={openSearchResult}
            />
          )}

          {mode === 'browse' && !(searchActive && searchQuery.trim()) && (
            <DirectoryListing
              entries={entries}
              loading={browseLoading}
              error={browseError}
              onOpenEntry={handleEntryClick}
            />
          )}

          {/* View mode */}
          {mode === 'view' && isImageFile(filePath) && (
            <ImageViewer
              src={getSessionFileRawUrl(projectId, sessionId, filePath)}
              fileName={fileName}
            />
          )}
          {mode === 'view' && downloadError?.path === filePath && (
            <div
              role="alert"
              className="m-4 p-3 bg-danger-tint rounded-lg text-xs"
              style={{ color: 'var(--sam-color-tn-red)' }}
            >
              {downloadError.message}
            </div>
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
    </GlassSheet>
  );
};
