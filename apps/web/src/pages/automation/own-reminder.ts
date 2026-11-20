import type { ProjectSchedule } from '@simple-agent-manager/shared';

/**
 * A reminder an agent (or SAM itself) set to message its own chat later, usually a fallback
 * check on CI or a queue. When one does not run, its chat has normally moved on and no person
 * can do anything about it, so it never asks for attention. Its outcome still shows on its own
 * page and in History.
 */
export function isChatOwnReminder(schedule: ProjectSchedule): boolean {
  return (
    (schedule.promptAuthor === 'agent' || schedule.promptAuthor === 'sam') &&
    schedule.action.kind === 'message_session' &&
    schedule.creatorChatSessionId !== null &&
    schedule.action.sessionId === schedule.creatorChatSessionId
  );
}
