/**
 * ProjectMessageView — the project chat's conversation, one session at a time.
 *
 * The view is keyed by session: selecting another chat unmounts the previous
 * chat's view and mounts a fresh one, so nothing from it — its transcript, agent
 * activity, a pending jump, an in-flight send — can render or act in the next
 * chat. That remount is cheap: the new view reads its transcript from the query
 * cache on its first render. What must outlive the switch lives above the key:
 * composer drafts (`SessionDraftsProvider`) and keyboard focus
 * (`SessionFocusHandoff`).
 */
import type { FC } from 'react';

import { SessionDraftsProvider } from './session-drafts';
import { SessionFocusHandoff } from './session-focus-handoff';
import { type ProjectMessageViewProps, SessionMessageView } from './SessionMessageView';

// Re-export utilities used by external consumers
export { chatMessagesToConversationItems } from './types';

export const ProjectMessageView: FC<ProjectMessageViewProps> = (props) => (
  <SessionDraftsProvider>
    <SessionFocusHandoff>
      <SessionMessageView key={props.sessionId} {...props} />
    </SessionFocusHandoff>
  </SessionDraftsProvider>
);
