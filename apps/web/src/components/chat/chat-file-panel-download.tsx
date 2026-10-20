import { Download } from 'lucide-react';
import type { FC } from 'react';

import { downloadSessionFile } from '../../lib/api';

export interface FileDownloadError {
  path: string;
  message: string;
}

/**
 * The file panel's Download button. A failed download (access ended, the file is gone, the
 * agent is unreachable) is reported through `onError` for the panel to show, rather than only
 * logged.
 */
export const DownloadFileButton: FC<{
  projectId: string;
  sessionId: string;
  filePath: string;
  onError: (error: FileDownloadError | null) => void;
}> = ({ projectId, sessionId, filePath, onError }) => (
  <button
    type="button"
    onClick={async () => {
      onError(null);
      try {
        const { blob, fileName } = await downloadSessionFile(projectId, sessionId, filePath);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Download failed:', err);
        const reason = err instanceof Error && err.message ? err.message : 'Please try again.';
        onError({ path: filePath, message: `Download failed. ${reason}` });
      }
    }}
    aria-label="Download file"
    className="p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
  >
    <Download size={14} />
  </button>
);
