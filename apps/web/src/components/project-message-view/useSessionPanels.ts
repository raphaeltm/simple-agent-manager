import { useCallback, useState } from 'react';

import type { FilePanelState } from './session-lifecycle-helpers';

export function useSessionPanels() {
  const [filePanel, setFilePanel] = useState<FilePanelState>(null);
  const handleFileClick = useCallback((path: string, line?: number | null) => {
    setFilePanel({ mode: 'view', path, line });
  }, []);
  const handleOpenFileBrowser = useCallback(() => setFilePanel({ mode: 'browse', path: '.' }), []);
  const handleOpenGitChanges = useCallback(() => setFilePanel({ mode: 'git-status' }), []);
  const [showScrollButton, setShowScrollButton] = useState(false);
  return {
    setFilePanel,
    filePanel,
    handleFileClick,
    handleOpenFileBrowser,
    handleOpenGitChanges,
    showScrollButton,
    setShowScrollButton,
  };
}
