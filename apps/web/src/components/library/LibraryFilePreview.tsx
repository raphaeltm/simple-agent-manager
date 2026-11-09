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
import { createPortal } from 'react-dom';

import { useQueryScope } from '../../hooks/useQueryScope';
import { downloadLibraryFile, getLibraryFilePreviewUrl } from '../../lib/api/library';
import { libraryFileQueryOptions } from '../../lib/query-options';
import { useDialogFocusTrap } from '../chat/useDialogFocusTrap';
import { FilePreviewModal } from './FilePreviewModal';

export interface LibraryFilePreviewProps {
  projectId: string;
  fileId: string;
  /** Shown while the metadata loads, so the viewer opens with the file's name. */
  filename?: string;
  onClose: () => void;
}

/** The viewer's frame before the file can be shown: still loading, or not found. */
function PreviewPlaceholder({
  title,
  error,
  onClose,
}: Readonly<{ title: string; error: boolean; onClose: () => void }>) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogFocusTrap(dialogRef, onClose);

  // Hand focus back to the opener on unmount. React runs this cleanup before the real viewer's
  // mount effect, so the viewer records the opener — not this frame — as where focus returns.
  // `useState` captures the opener during the first render, before the trap moves focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus(), [opener]);

  return createPortal(
    <div className="sam-void fixed inset-0 z-dialog-backdrop flex flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),0.375rem)] pl-[max(env(safe-area-inset-left),0.375rem)] pr-[max(env(safe-area-inset-right),0.375rem)] pt-[max(env(safe-area-inset-top),0.375rem)] md:p-2.5">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-dialog flex min-h-0 flex-1 flex-col gap-1.5 outline-none md:gap-2.5"
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
      </div>
    </div>,
    document.body
  );
}

export function LibraryFilePreview({
  projectId,
  fileId,
  filename,
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
    />
  );
}
