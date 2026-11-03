import type { SegmentedOption } from '@simple-agent-manager/ui';

import type { ChatSessionListItem } from '../../lib/api';
import type { SessionScope } from './useProjectChatState';

/**
 * Mine / All choices for the chat list's ownership filter, with counts where the loaded list
 * can tell them. Under "All" both are known; under "Mine" the list holds only your sessions,
 * so "All" shows no count rather than a wrong one.
 */
export function sessionScopeOptions(
  sessions: ChatSessionListItem[],
  scope: SessionScope
): SegmentedOption<SessionScope>[] {
  const mine = sessions.filter((session) => session.isMine).length;
  const all = scope === 'all' ? sessions.length : undefined;
  return [
    {
      value: 'my',
      label: 'Mine',
      count: mine,
      ariaLabel: `My sessions, ${mine}`,
    },
    {
      value: 'all',
      label: 'All',
      count: all,
      ariaLabel: all === undefined ? 'All sessions' : `All sessions, ${all}`,
    },
  ];
}
