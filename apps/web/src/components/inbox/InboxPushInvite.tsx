import { Alert, Button } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';

import { usePushSubscription } from '../../hooks/usePushSubscription';
import { useAuth } from '../AuthProvider';
import { useInboxCount } from './useInbox';

function dismissedKey(userId: string): string {
  return `sam-push-invitation-dismissed-${userId}`;
}

/**
 * Offers push notifications once an agent is blocked on the person and this device is not
 * subscribed. Moved from the old bell panel; dismissal is remembered per user and device.
 */
export function InboxPushInvite() {
  const { user } = useAuth();
  const key = dismissedKey(user?.id ?? 'anonymous');
  const [dismissed, setDismissed] = useState(false);
  const push = usePushSubscription();
  const blocking = useInboxCount(null).data?.blocking ?? 0;

  useEffect(() => {
    setDismissed(localStorage.getItem(key) === 'true');
  }, [key]);

  const show =
    blocking > 0 &&
    push.supported &&
    !push.isLoading &&
    !push.isSubscribed &&
    push.permission !== 'denied' &&
    !dismissed;
  if (!show) return null;

  return (
    <div className="border-b border-[var(--sam-hairline)] p-3">
      <Alert variant="info">
        <div className="space-y-2">
          <p className="text-xs">Get agent questions on this device even when SAM is closed.</p>
          {push.error && (
            <p role="alert" className="text-xs">
              {push.error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={push.isBusy} onClick={() => void push.enable()}>
              Enable push
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                localStorage.setItem(key, 'true');
                setDismissed(true);
              }}
            >
              Not now
            </Button>
          </div>
        </div>
      </Alert>
    </div>
  );
}
