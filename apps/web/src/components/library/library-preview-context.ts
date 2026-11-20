import { createContext, useContext } from 'react';
import * as v from 'valibot';

/** One Library file to show in the in-place preview. */
export interface LibraryPreviewRequest {
  projectId: string;
  fileId: string;
  /** Shown while the file's metadata loads, so the viewer opens with its name. */
  filename?: string;
  /** Open with the comments panel on this thread. */
  commentThreadId?: string | null;
}

export type OpenLibraryFile = (request: LibraryPreviewRequest) => void;

export const LibraryPreviewContext = createContext<OpenLibraryFile | null>(null);

/**
 * Opens a Library file over the current screen (`LibraryPreviewProvider`). Null outside the
 * provider, where a caller falls back to its plain link.
 */
export function useLibraryPreview(): OpenLibraryFile | null {
  return useContext(LibraryPreviewContext);
}

/** The history-state key holding the open preview (`LibraryPreviewProvider`). */
export const LIBRARY_PREVIEW_STATE_KEY = 'samLibraryPreview';

// History state survives reloads and is shared with every page's own keys, so it is read through
// a schema rather than trusted (a malformed value opens nothing).
const PreviewStateSchema = v.object({
  projectId: v.pipe(v.string(), v.minLength(1)),
  fileId: v.pipe(v.string(), v.minLength(1)),
  filename: v.optional(v.string()),
  commentThreadId: v.optional(v.nullable(v.string())),
});

/** The preview a history entry's state holds open, or null. */
export function readLibraryPreview(state: unknown): LibraryPreviewRequest | null {
  if (!state || typeof state !== 'object') return null;
  const parsed = v.safeParse(
    PreviewStateSchema,
    (state as Record<string, unknown>)[LIBRARY_PREVIEW_STATE_KEY]
  );
  return parsed.success ? parsed.output : null;
}
