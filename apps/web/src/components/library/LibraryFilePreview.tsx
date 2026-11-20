/**
 * Opens one library file's preview by ID, wherever the file is referenced from.
 *
 * Callers only need the ID. The file's metadata is read on its own — one small request,
 * skipped when the library page has already seeded it from a row — so the chat's Related panel
 * and a direct `?preview=` link open the file without waiting for the library index sweep.
 */
import { IconButton, paneClassName, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { downloadLibraryFile, getLibraryFilePreviewUrl } from '../../lib/api/library';
import { libraryFileQueryOptions } from '../../lib/query-options';
import { useDialogFocusTrap } from '../chat/useDialogFocusTrap';
import { FilePreviewModal } from './FilePreviewModal';
import { PreviewFrame, type PreviewPresentation } from './PreviewFrame';

export interface LibraryFilePreviewProps {
  projectId: string;
  fileId: string;
  /** Shown while the metadata loads, so the viewer opens with the file's name. */
  filename?: string;
  /** Open the comments panel on this thread, from a comment deep link. */
  commentThreadId?: string | null;
  /** See `PreviewFrame`. The Library page shows its own files as a screen. */
  presentation?: PreviewPresentation;
  /** Offered as "Open in Library" when the preview was opened from elsewhere. */
  onOpenInLibrary?: () => void;
  onClose: () => void;
}

/** The viewer's frame before the file can be shown: still loading, or not found. */
function PreviewPlaceholder({
  title,
  error,
  presentation,
  onClose,
}: Readonly<{
  title: string;
  error: boolean;
  presentation: PreviewPresentation;
  onClose: () => void;
}>) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocusTrap(dialogRef, onClose);

  // Hand focus back to the opener on unmount. React runs this cleanup before the real viewer's
  // mount effect, so the viewer records the opener — not this frame — as where focus returns.
  // `useState` captures the opener during the first render, before the trap moves focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);

  return (
    <PreviewFrame
      presentation={presentation}
      dialogRef={dialogRef}
      onClose={onClose}
      aria-label={title}
      data-testid="library-file-preview-placeholder"
    >
      <header
        className={`${paneClassName('slab')} flex shrink-0 items-center gap-1 py-1 pl-3.5 pr-1 md:pl-4`}
      >
        <h3 className="m-0 min-w-0 flex-1 truncate py-1 text-sm font-semibold text-fg-primary md:text-[15px]">
          {title}
        </h3>
        <IconButton
          label="Close preview"
          icon={<X size={18} aria-hidden="true" />}
          onClick={onClose}
        />
      </header>
      <section
        className={`${paneClassName('quiet')} flex min-h-0 flex-1 items-center justify-center p-8 text-center`}
      >
        {error ? (
          <p className="m-0 max-w-sm text-sm text-fg-muted">
            This file couldn&apos;t be opened. It may have been deleted.
          </p>
        ) : (
          <Spinner size="lg" />
        )}
      </section>
    </PreviewFrame>
  );
}

export function LibraryFilePreview({
  projectId,
  fileId,
  filename,
  commentThreadId = null,
  presentation = 'screen',
  onOpenInLibrary,
  onClose,
}: LibraryFilePreviewProps) {
  const queryScope = useQueryScope();
  const metadata = useQuery({
    ...libraryFileQueryOptions(queryScope, projectId, fileId),
    enabled: Boolean(queryScope),
  });

  if (!metadata.data) {
    return (
      <PreviewPlaceholder
        title={filename ?? 'Opening file'}
        error={metadata.isError}
        presentation={presentation}
        onClose={onClose}
      />
    );
  }

  return (
    <FilePreviewModal
      projectId={projectId}
      file={metadata.data}
      previewUrl={getLibraryFilePreviewUrl(projectId, fileId)}
      onClose={onClose}
      onDownload={() => downloadLibraryFile(projectId, fileId)}
      initialCommentThreadId={commentThreadId}
      presentation={presentation}
      onOpenInLibrary={onOpenInLibrary}
    />
  );
}
