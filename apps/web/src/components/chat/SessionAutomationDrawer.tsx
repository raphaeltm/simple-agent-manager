/**
 * The chat tool rail's "Automation" panel: what this chat is waiting for, what is set to
 * message it, and "Remind this chat later". Replaced the session Events drawer.
 */
import { Workflow, X } from 'lucide-react';
import { useRef } from 'react';
import { createPortal } from 'react-dom';

import { automationPaths } from '../../lib/automation-routes';
import { ChatAutomation } from '../../pages/automation/chat-automation';
import { ButtonLink } from '../../pages/automation/ui';
import { useDialogFocusTrap } from './useDialogFocusTrap';

interface SessionAutomationDrawerProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

export function SessionAutomationDrawer({
  projectId,
  sessionId,
  onClose,
}: SessionAutomationDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[440px] lg:w-[520px]"
        role="dialog"
        aria-modal="true"
        aria-label="Automation for this chat"
        data-testid="session-automation-drawer"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border-default px-3 py-1">
          <Workflow size={18} className="shrink-0 text-fg-muted" aria-hidden />
          <h2 className="m-0 min-w-0 flex-1 text-[15px] font-semibold text-fg-primary">
            Automation for this chat
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-md bg-transparent text-fg-muted transition-colors hover:text-fg-primary"
            aria-label="Close automation"
          >
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ChatAutomation sessionId={sessionId} />
        </div>
        <footer className="flex shrink-0 flex-wrap gap-3 border-t border-border-default px-4 py-3">
          <ButtonLink to={automationPaths.overview(projectId)}>All automation</ButtonLink>
          <ButtonLink to={automationPaths.behind(projectId, { sessionId })}>
            Open as a page
          </ButtonLink>
        </footer>
      </div>
    </>,
    document.body
  );
}
