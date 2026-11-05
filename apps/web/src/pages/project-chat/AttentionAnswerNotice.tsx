import { Button } from '@simple-agent-manager/ui';
import { Check, CircleAlert } from 'lucide-react';

import {
  NOTICE_ACTION_CLASS,
  NoticeSlab,
  NoticeTextButton,
} from '../../components/chat-notices/NoticeSlab';

export interface AttentionAnswerStatus {
  variant: 'success' | 'error';
  message: string;
}

/** The result of answering an agent's question from a notification deep link. */
export function AttentionAnswerNotice({
  status,
  onDismiss,
  onRetry,
}: Readonly<{
  status: AttentionAnswerStatus;
  onDismiss: () => void;
  /** Present only when a failed answer can be sent again. */
  onRetry?: () => void;
}>) {
  const failed = status.variant === 'error';
  return (
    <NoticeSlab
      role="alert"
      compact
      tone={failed ? 'danger' : 'success'}
      icon={failed ? <CircleAlert size={15} /> : <Check size={15} />}
      title={status.message}
      actions={
        <>
          <NoticeTextButton onClick={onDismiss}>Dismiss</NoticeTextButton>
          {failed && onRetry && (
            <Button variant="raised" size="sm" className={NOTICE_ACTION_CLASS} onClick={onRetry}>
              Retry answer
            </Button>
          )}
        </>
      }
    />
  );
}
