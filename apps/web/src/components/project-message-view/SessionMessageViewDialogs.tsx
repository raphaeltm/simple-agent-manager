import {
  isShareableChatSessionStatus,
  type SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { lazy, Suspense } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { importWithRetry } from '../../lib/lazy-with-retry';
import { ReportIssueDialog } from '../ReportIssueDialog';
import { sessionOwnerLabel } from './session-viewer-access';
import { SessionHeaderCompletionDialog } from './SessionHeaderCompletionDialog';
import { SessionShareDialog } from './SessionShareDialog';
import type { UseSessionToolsResult } from './useSessionTools';

// Loaded when first opened: the Automation panel's code stays out of the chat's own bundle.
const SessionAutomationDrawer = lazy(async () => ({
  default: (await importWithRetry(() => import('../chat/SessionAutomationDrawer')))
    .SessionAutomationDrawer,
}));

/**
 * The overlays the session tool rail opens: automation, report, complete and share. They live
 * beside the view rather than in `SessionHeader` because the actions that open them do.
 * Split out of `SessionMessageView` (`.claude/rules/18-file-size-limits.md`).
 */
export function SessionMessageViewDialogs({
  projectId,
  sessionId,
  session,
  nodeId,
  viewerId,
  sessionTools,
  showAutomation,
  onCloseAutomation,
  showShare,
  onCloseShare,
  onAccessChanged,
}: Readonly<{
  projectId: string;
  sessionId: string;
  session: ChatSessionResponse;
  nodeId: string | null;
  viewerId: string | null;
  sessionTools: UseSessionToolsResult;
  showAutomation: boolean;
  onCloseAutomation: () => void;
  showShare: boolean;
  onCloseShare: () => void;
  onAccessChanged: (access: SessionAccessSummary) => void;
}>) {
  return (
    <>
      {showAutomation && (
        <Suspense fallback={null}>
          <SessionAutomationDrawer
            projectId={projectId}
            sessionId={sessionId}
            onClose={onCloseAutomation}
          />
        </Suspense>
      )}

      {showShare && session.access && viewerId && (
        <SessionShareDialog
          projectId={projectId}
          sessionId={sessionId}
          sessionTopic={session.topic}
          access={session.access}
          viewerUserId={viewerId}
          ownerLabel={sessionOwnerLabel(session)}
          onClose={onCloseShare}
          onChanged={onAccessChanged}
          canAddPeople={isShareableChatSessionStatus(session.status)}
        />
      )}

      <ReportIssueDialog
        isOpen={sessionTools.reportOpen}
        onClose={sessionTools.closeReport}
        refs={{
          sessionId,
          taskId: session.taskId || undefined,
          nodeId: nodeId || undefined,
        }}
      />
      <SessionHeaderCompletionDialog
        isOpen={sessionTools.confirmCompleteOpen}
        onClose={sessionTools.closeConfirmComplete}
        onConfirm={sessionTools.confirmComplete}
      />
    </>
  );
}
