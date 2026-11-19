/**
 * The chat tool rail's "Automation" panel: what this chat is waiting for, what is set to
 * message it, and "Remind this chat later". Replaced the session Events drawer.
 */
import { Workflow } from 'lucide-react';
import { useRef } from 'react';

import { automationPaths } from '../../lib/automation-routes';
import { ChatAutomation } from '../../pages/automation/chat-automation';
import { ButtonLink } from '../../pages/automation/ui';
import { GlassSheet, GlassSheetHeader } from '../shell/GlassSheet';
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

  return (
    <GlassSheet
      label="Automation for this chat"
      panelRef={panelRef}
      onBackdropClick={onClose}
      backdrop="desktop"
      mobile="full"
      widthClassName="w-full md:w-[440px] lg:w-[520px]"
      zClassName="z-50"
      backdropZClassName="z-40"
      animated={false}
      testId="session-automation-drawer"
    >
        <GlassSheetHeader
          icon={<Workflow size={20} strokeWidth={1.75} />}
          title="Automation for this chat"
          onClose={onClose}
          closeLabel="Close automation"
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <ChatAutomation sessionId={sessionId} />
        </div>
        <footer className="flex shrink-0 flex-wrap gap-3 border-t border-[var(--sam-hairline)] px-4 py-3">
          <ButtonLink to={automationPaths.overview(projectId)}>All automation</ButtonLink>
          <ButtonLink to={automationPaths.behind(projectId, { sessionId })}>
            Open as a page
          </ButtonLink>
        </footer>
    </GlassSheet>
  );
}
