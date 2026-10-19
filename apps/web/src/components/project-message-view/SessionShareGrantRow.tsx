import type { SessionAccessGrant } from '@simple-agent-manager/shared';
import { Avatar, Button } from '@simple-agent-manager/ui';

import { accessClockTime, accessTimeLeft } from './session-access-time';

/** A person's display name from an access summary, or `fallback` when the server has none. */
export function personName(
  person: { name: string | null } | null | undefined,
  fallback: string
): string {
  return person?.name?.trim() || fallback;
}

/**
 * One person in the share dialog's "People with access" list: when their access ends, Revoke
 * now (or Leave, on your own row) behind a small inline confirmation, and Renew for the owner.
 * Split out of `SessionShareDialog` (`.claude/rules/18-file-size-limits.md`).
 */
export function GrantRow({
  grant,
  viewerUserId,
  now,
  canManage,
  canRenew,
  cascades,
  confirmingRemoval,
  removing,
  busy,
  error,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
  onRenew,
}: Readonly<{
  grant: SessionAccessGrant;
  viewerUserId: string;
  /** The server's clock. */
  now: number;
  canManage: boolean;
  /** Only the owner extends someone's access. */
  canRenew: boolean;
  cascades: boolean;
  confirmingRemoval: boolean;
  removing: boolean;
  busy: boolean;
  error: string | null;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
  onRenew: () => void;
}>) {
  const isSelf = grant.grantee.id === viewerUserId;
  const name = personName(grant.grantee, 'A teammate');
  const addedBy =
    grant.grantedBy.id === viewerUserId ? 'you' : personName(grant.grantedBy, 'a teammate');
  const timeLeft = accessTimeLeft(grant.expiresAt, now);
  // A grantee can always remove their own access.
  const canRemove = timeLeft !== null && (isSelf || canManage);
  const showRenew = canRenew && !isSelf && !confirmingRemoval;
  const actionLabel = isSelf ? 'Leave' : 'Revoke now';

  return (
    <li className="min-w-0 px-3 py-2">
      <div className="flex min-h-10 min-w-0 items-center gap-3">
        <Avatar name={name} imageUrl={grant.grantee.avatarUrl} tone="human" size="lg" />
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-medium text-fg-primary [overflow-wrap:anywhere]">
            {name}
            {isSelf && <span className="font-normal text-fg-muted"> (you)</span>}
          </p>
          <p className="m-0 text-xs text-fg-muted [overflow-wrap:anywhere]">
            added by {addedBy} ·{' '}
            {timeLeft === null ? (
              <span className="text-warning-fg">access ended</span>
            ) : (
              <span data-testid="grant-time-left">
                ends in {timeLeft} ({accessClockTime(grant.expiresAt)})
              </span>
            )}
          </p>
        </div>
        {(showRenew || (canRemove && !confirmingRemoval)) && (
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            {showRenew && (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-9"
                onClick={onRenew}
                disabled={busy}
                aria-label={`Renew ${name}'s access`}
              >
                Renew
              </Button>
            )}
            {canRemove && !confirmingRemoval && (
              <Button
                size="sm"
                variant="ghost"
                className="min-h-11 sm:min-h-9"
                onClick={onAskRemove}
                disabled={busy}
                aria-label={isSelf ? 'Leave this chat' : `Revoke ${name}'s access now`}
              >
                {actionLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {confirmingRemoval && (
        <div className="mt-2 rounded-md border border-border-default bg-inset p-3">
          <p className="m-0 text-sm text-fg-primary [overflow-wrap:anywhere]">
            {isSelf
              ? "Leave this chat? You won't be able to send messages here anymore."
              : `Revoke ${name}'s access now? They won't be able to send messages here anymore.`}
          </p>
          <p className="m-0 mt-1 text-sm text-fg-secondary">
            {cascades
              ? isSelf
                ? 'This also removes anyone you added. '
                : 'This also removes anyone they added. '
              : ''}
            Work the agent already started keeps running.
          </p>
          {error && (
            <p role="alert" className="m-0 mt-2 text-sm text-danger-fg [overflow-wrap:anywhere]">
              {error}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="danger"
              className="min-h-11 sm:min-h-9"
              onClick={onConfirmRemove}
              loading={removing}
            >
              {actionLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-9"
              onClick={onCancelRemove}
              disabled={removing}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
