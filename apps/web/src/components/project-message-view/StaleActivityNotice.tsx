import type { FC } from 'react';

import { FooterNoticeRow, NoticeTextButton } from '../chat-notices/NoticeSlab';

interface StaleActivityNoticeProps {
  onDismiss: () => void;
}

/**
 * Inline notice shown once per verified-stale transition: the UI was showing
 * "Agent is working…" but the server confirmed the session is idle. Making
 * the downgrade visible (instead of silently flipping the spinner) is the
 * fail-visibly contract for silent stalls. A row in the message-box slab.
 */
export const StaleActivityNotice: FC<StaleActivityNoticeProps> = ({ onDismiss }) => (
  <FooterNoticeRow
    tone="warning"
    action={<NoticeTextButton onClick={onDismiss}>Dismiss</NoticeTextButton>}
  >
    Agent went quiet — no confirmed activity
  </FooterNoticeRow>
);
