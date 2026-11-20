/**
 * Opens Library files over whatever screen referenced them, instead of navigating to the Library.
 *
 * The open preview lives in the browser history entry's state, at the same URL: opening pushes an
 * entry and closing goes back to the one before it. So a phone's Back button closes the preview,
 * the URL never becomes the Library, and the page underneath is never remounted (its scroll
 * position, half-typed text and selection survive). Existing entry state is kept, because pages
 * read their own keys from it (`InboxPage`, `useInboxWalk`).
 *
 * One provider for the whole app means one viewer: every reference (inbox chips, idea Related
 * rows, comment threads, workflow outputs, markdown links) calls `useLibraryPreview()` rather than
 * each mounting `LibraryFilePreview` itself.
 */
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { importWithRetry } from '../../lib/lazy-with-retry';
import { projectLibraryFilePath } from '../../lib/project-routes';
import {
  LIBRARY_PREVIEW_STATE_KEY,
  LibraryPreviewContext,
  type LibraryPreviewRequest,
  readLibraryPreview as readPreview,
} from './library-preview-context';

// The viewer (markdown, media, comments) loads when a file is first opened, not with the app
// shell this provider sits in.
const LibraryFilePreview = lazy(async () => ({
  default: (await importWithRetry(() => import('./LibraryFilePreview'))).LibraryFilePreview,
}));

function withoutPreview(state: unknown): Record<string, unknown> | null {
  if (!state || typeof state !== 'object') return null;
  const rest: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  delete rest[LIBRARY_PREVIEW_STATE_KEY];
  return Object.keys(rest).length > 0 ? rest : null;
}

/** React Router's key for the first entry of a tab: there is nothing behind it to go back to. */
const FIRST_ENTRY_KEY = 'default';

export function LibraryPreviewProvider({ children }: Readonly<{ children: ReactNode }>) {
  const location = useLocation();
  const navigate = useNavigate();
  const preview = readPreview(location.state);

  // Read through a ref so `openLibraryFile` keeps one identity across navigations: every
  // reference on the page consumes it, and a new identity per navigation would re-render them all.
  const locationRef = useRef(location);
  locationRef.current = location;

  // What had focus on the page when the preview session began. A link inside one preview can
  // replace it with another file; focus must still go back to the page control, not to a link in
  // a viewer that no longer exists.
  const openerRef = useRef<HTMLElement | null>(null);

  const openLibraryFile = useCallback(
    (request: LibraryPreviewRequest) => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !active.closest('[data-library-preview-root]')) {
        openerRef.current = active;
      }
      const current = locationRef.current;
      const base = withoutPreview(current.state) ?? {};
      navigate(
        { pathname: current.pathname, search: current.search, hash: current.hash },
        // Opening over an open preview replaces it, so one Back still returns to the page.
        {
          replace: readPreview(current.state) !== null,
          state: { ...base, [LIBRARY_PREVIEW_STATE_KEY]: request },
        }
      );
    },
    [navigate]
  );

  const close = useCallback(() => {
    // The entry holding the preview was pushed over the page it was opened from, so going back
    // returns there. The first entry of a tab has nothing behind it; drop the key instead.
    if (location.key !== FIRST_ENTRY_KEY) {
      navigate(-1);
      return;
    }
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: withoutPreview(location.state) }
    );
  }, [location.hash, location.key, location.pathname, location.search, location.state, navigate]);

  const isOpen = preview !== null;
  useEffect(() => {
    if (isOpen) return;
    // The viewer hands focus back to whatever it captured on mount; after a replaced preview that
    // is gone, so return it to the page control that started the session.
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected && document.activeElement !== opener) opener.focus();
  }, [isOpen]);

  const openInLibrary = useCallback(() => {
    if (!preview) return;
    // Keep the thread a comment link opened on, so the Library opens with it too.
    navigate(
      projectLibraryFilePath(
        preview.projectId,
        preview.fileId,
        preview.commentThreadId ?? undefined
      )
    );
  }, [navigate, preview]);

  return (
    <LibraryPreviewContext.Provider value={openLibraryFile}>
      {children}
      {preview && (
        <Suspense fallback={null}>
          <LibraryFilePreview
            // A different file or thread opens a fresh viewer, so its panel and focus start anew.
            key={`${preview.projectId}:${preview.fileId}:${preview.commentThreadId ?? ''}`}
            projectId={preview.projectId}
            fileId={preview.fileId}
            filename={preview.filename}
            commentThreadId={preview.commentThreadId ?? null}
            presentation="overlay"
            onOpenInLibrary={openInLibrary}
            onClose={close}
          />
        </Suspense>
      )}
    </LibraryPreviewContext.Provider>
  );
}
