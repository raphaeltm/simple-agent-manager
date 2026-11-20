/**
 * A reference to a Library file. A plain click opens the file's preview over the current screen
 * (`LibraryPreviewProvider`); the element stays a real link to the Library, so a modified click,
 * a middle click or "copy link" still reach the Library page. Outside the provider it is just
 * that link.
 */
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Link } from 'react-router';

import { projectLibraryFilePath } from '../../lib/project-routes';
import { type LibraryPreviewRequest, useLibraryPreview } from './library-preview-context';

export interface LibraryFileLinkProps
  extends
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'children'>,
    LibraryPreviewRequest {
  children: ReactNode;
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function LibraryFileLink({
  projectId,
  fileId,
  filename,
  commentThreadId,
  children,
  onClick,
  ...anchorProps
}: LibraryFileLinkProps) {
  const openLibraryFile = useLibraryPreview();
  return (
    <Link
      {...anchorProps}
      to={projectLibraryFilePath(projectId, fileId, commentThreadId ?? undefined)}
      aria-haspopup={openLibraryFile ? 'dialog' : undefined}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !openLibraryFile || !isPlainClick(event)) return;
        event.preventDefault();
        openLibraryFile({ projectId, fileId, filename, commentThreadId });
      }}
    >
      {children}
    </Link>
  );
}
