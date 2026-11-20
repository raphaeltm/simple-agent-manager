import { createContext, useContext } from 'react';

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
