import type { SessionAccessSummary } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';
import { SessionEventsDrawer } from '../chat/SessionEventsDrawer';
import { ReportIssueDialog } from '../ReportIssueDialog';
import { sessionOwnerLabel } from './session-viewer-access';
import { SessionHeaderCompletionDialog } from './SessionHeaderCompletionDialog';
import { SessionShareDialog } from './SessionShareDialog';
import type { UseSessionToolsResult } from './useSessionTools';

/**
 * The overlays the session tool rail opens: events, report, complete and share. They live
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
  showEvents,
  onCloseEvents,
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
  showEvents: boolean;
  onCloseEvents: () => void;
  showShare: boolean;
  onCloseShare: () => void;
  onAccessChanged: (access: SessionAccessSummary) => void;
}>) {
  return (
    <>
      {showEvents && (
        <SessionEventsDrawer projectId={projectId} sessionId={sessionId} onClose={onCloseEvents} />
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
