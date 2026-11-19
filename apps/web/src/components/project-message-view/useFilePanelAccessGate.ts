import { type RefObject, useEffect, useRef, useState } from 'react';

export const FILE_PANEL_ACCESS_ENDED_NOTICE = 'Your shared access ended, so the file panel closed.';

/**
 * A teammate's Files/Git panel closes when their shared access ends; the server already refuses
 * its next read (idea 01M59MYE4GY91BWTE8TZF1ZB5D). Focus moves to the footer notice that says
 * why, and the returned text is for a status line, so a keyboard or screen-reader user is not
 * left on a panel that vanished.
 */
export function useFilePanelAccessGate({
  canBrowseWorkspace,
  filePanelOpen,
  setFilePanel,
  accessNoticeRef,
}: {
  canBrowseWorkspace: boolean;
  filePanelOpen: boolean;
  setFilePanel: (panel: null) => void;
  accessNoticeRef: RefObject<HTMLElement | null>;
}): string {
  const couldBrowseWorkspace = useRef(canBrowseWorkspace);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const lostAccess = couldBrowseWorkspace.current && !canBrowseWorkspace;
    couldBrowseWorkspace.current = canBrowseWorkspace;
    // Clear on regained access, so a second loss is announced again.
    if (canBrowseWorkspace) setNotice('');
    if (!lostAccess || !filePanelOpen) return;
    setFilePanel(null);
    setNotice(FILE_PANEL_ACCESS_ENDED_NOTICE);
    accessNoticeRef.current?.focus();
  }, [canBrowseWorkspace, filePanelOpen, setFilePanel, accessNoticeRef]);
  return notice;
}
