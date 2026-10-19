import type {
  RevokeSessionAccessGrantResponse,
  SessionAccessDurationMinutes,
  SessionAccessGrant,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { Avatar, useModalInteraction } from '@simple-agent-manager/ui';
import { useMutation } from '@tanstack/react-query';
import { Users, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ProjectMemberSummary } from '../../hooks/useProjectMembers';
import { revokeSessionAccess, shareSessionAccess } from '../../lib/api/session-access';
import { accessClockTime, useServerNow } from './session-access-time';
import { AddTeammateSection, memberLabel } from './SessionShareAddTeammate';
import {
  type OwnerWords,
  SessionShareConfirmStep,
  type ShareTarget,
} from './SessionShareConfirmStep';
import { GrantRow, personName } from './SessionShareGrantRow';

export interface SessionShareDialogProps {
  projectId: string;
  sessionId: string;
  sessionTopic: string | null;
  access: SessionAccessSummary;
  viewerUserId: string;
  /** The session owner's display name, e.g. from `sessionOwnerLabel`. */
  ownerLabel: string;
  onClose: () => void;
  /** The server's access summary after a share or a removal. */
  onChanged: (access: SessionAccessSummary) => void;
  /**
   * False once the chat has ended (`isShareableChatSessionStatus`): no one new can be added, but
   * people can still be removed.
   */
  canAddPeople: boolean;
}

function ownerWords(viewerIsOwner: boolean, ownerLabel: string): OwnerWords {
  return viewerIsOwner
    ? { possessive: 'your', object: 'you', firstPersonPossessive: 'my' }
    : {
        possessive: `${ownerLabel}'s`,
        object: ownerLabel,
        firstPersonPossessive: `${ownerLabel}'s`,
      };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Whether removing `grant` also removes others: anyone that person added. */
function hasDownstreamGrants(grants: readonly SessionAccessGrant[], grant: SessionAccessGrant) {
  return grants.some(
    (candidate) =>
      candidate.id !== grant.id &&
      (candidate.parentGrantId === grant.id || candidate.grantedBy.id === grant.grantee.id)
  );
}

function removalNotice(
  response: RevokeSessionAccessGrantResponse,
  removedName: string,
  leftSelf: boolean
): string {
  const parts = [leftSelf ? 'You left this chat.' : `Removed ${removedName}.`];
  const cascaded = response.revokedGrantIds.length - 1;
  if (cascaded > 0) {
    parts.push(
      `Also removed ${plural(cascaded, 'person', 'people')} ${leftSelf ? 'you' : 'they'} added.`
    );
  }
  const cancelled = response.cancelledDeliveryIds.length;
  if (cancelled > 0) {
    parts.push(
      `Cancelled ${plural(cancelled, 'queued message', 'queued messages')} that hadn't reached the agent yet.`
    );
  }
  return parts.join(' ');
}

/**
 * "Share chat access" — give a teammate owner-equivalent control of one chat session for a
 * chosen 5, 10, 30 or 60 minutes.
 *
 * Everything a person added here does runs on the owner's accounts (agent credential, GitHub
 * identity, compute), and the agent can read the owner's keys. The dialog says that in plain
 * words and requires an explicit acknowledgement and a duration before sharing; the server
 * enforces both and the other rules (active membership, grant limit) and ends access at the
 * chosen time. Only the owner renews. Once shared, the teammate's messages are handled exactly
 * like the owner's.
 *
 * Bottom sheet on phones, centered ~480px dialog from `sm` up. Focus trap, Escape and
 * background isolation come from the shared `useModalInteraction`.
 */
export function SessionShareDialog({
  projectId,
  sessionId,
  sessionTopic,
  access,
  viewerUserId,
  ownerLabel,
  onClose,
  onChanged,
  canAddPeople,
}: SessionShareDialogProps) {
  const titleId = useId();
  const introId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmHeadingRef = useRef<HTMLHeadingElement>(null);
  const [confirming, setConfirming] = useState<ShareTarget | null>(null);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useServerNow(true);

  useModalInteraction({ enabled: true, modalRef: panelRef, onEscape: onClose });

  const viewerIsOwner = access.viewerAccess === 'owner' || access.owner?.id === viewerUserId;
  const canManage = access.viewerAccess === 'owner' || access.viewerAccess === 'grantee';
  const words = ownerWords(viewerIsOwner, ownerLabel);
  const grants = [...access.grants].sort((a, b) => a.createdAt - b.createdAt);
  const viewerExpiresAt = viewerIsOwner
    ? null
    : (grants.find((grant) => grant.grantee.id === viewerUserId)?.expiresAt ?? null);

  const shareMutation = useMutation({
    mutationFn: (input: { target: ShareTarget; durationMinutes: SessionAccessDurationMinutes }) =>
      shareSessionAccess(projectId, sessionId, input.target.userId, input.durationMinutes),
    onSuccess: (response, { target }) => {
      onChanged(response.access);
      setConfirming(null);
      const until = accessClockTime(response.grant.expiresAt);
      setNotice(
        response.renewed
          ? `${target.name}'s access now ends at ${until}.`
          : response.created
            ? `${target.name} can use this chat until ${until}.`
            : `${target.name} already has access, until ${until}.`
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (grant: SessionAccessGrant) =>
      revokeSessionAccess(projectId, sessionId, grant.grantee.id),
    onSuccess: (response, grant) => {
      onChanged(response.access);
      setPendingRemovalId(null);
      setNotice(
        removalNotice(
          response,
          personName(grant.grantee, 'them'),
          grant.grantee.id === viewerUserId
        )
      );
    },
  });

  // Moving between the list and the confirm step replaces the control that had focus, so
  // put focus somewhere meaningful rather than letting it fall back to the page.
  useEffect(() => {
    if (confirming) confirmHeadingRef.current?.focus();
  }, [confirming]);

  const startConfirm = (target: ShareTarget) => {
    shareMutation.reset();
    setNotice(null);
    setPendingRemovalId(null);
    setConfirming(target);
  };

  const backToList = () => {
    shareMutation.reset();
    setConfirming(null);
    panelRef.current?.focus();
  };

  return createPortal(
    <div
      data-sam-modal-root=""
      className="fixed inset-0 z-dialog-backdrop flex items-end justify-center sm:items-center sm:p-4"
    >
      <div
        className="fixed inset-0 bg-overlay glass-backdrop-dim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        tabIndex={-1}
        className="glass-panel-container glass-composited glass-modal relative flex max-h-[92dvh] w-full min-w-0 flex-col overflow-hidden rounded-t-2xl shadow-overlay focus:outline-none sm:max-h-[min(44rem,calc(100dvh-2rem))] sm:max-w-[30rem] sm:rounded-2xl"
      >
        <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-border-default px-4 py-2">
          <Users size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 text-base font-semibold text-fg-primary">
              Share chat access
            </h2>
            {sessionTopic && (
              <p className="m-0 truncate text-xs text-fg-muted" title={sessionTopic}>
                {sessionTopic}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <p id={introId} className="m-0 text-sm leading-relaxed text-fg-secondary">
            {canManage
              ? `People you add can message the agent and manage this chat, just like you, for as long as you choose. It runs on ${words.possessive} accounts.`
              : `The people below can message the agent and manage this chat, just like the owner, until their access ends. It runs on ${words.possessive} accounts.`}
          </p>

          {confirming ? (
            <SessionShareConfirmStep
              key={`${confirming.userId}:${confirming.renewing ? 'renew' : 'share'}`}
              target={confirming}
              words={words}
              headingId={`${titleId}-confirm`}
              headingRef={confirmHeadingRef}
              now={now}
              viewerExpiresAt={viewerExpiresAt}
              pending={shareMutation.isPending}
              error={shareMutation.error ? errorMessage(shareMutation.error) : null}
              onBack={backToList}
              onConfirm={(durationMinutes) =>
                shareMutation.mutate({ target: confirming, durationMinutes })
              }
            />
          ) : (
            <>
              {notice && (
                <p
                  role="status"
                  className="mt-3 mb-0 rounded-md border border-border-default bg-inset px-3 py-2 text-sm text-fg-primary [overflow-wrap:anywhere]"
                >
                  {notice}
                </p>
              )}

              <section aria-labelledby={`${titleId}-people`} className="mt-4">
                <h3
                  id={`${titleId}-people`}
                  className="m-0 text-xs font-semibold tracking-wide text-fg-muted uppercase"
                >
                  People with access
                </h3>
                <ul className="m-0 mt-2 flex list-none flex-col divide-y divide-border-default rounded-md border border-border-default p-0">
                  <li className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2">
                    <Avatar
                      name={personName(access.owner, ownerLabel)}
                      imageUrl={access.owner?.avatarUrl}
                      tone="human"
                      size="lg"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-medium text-fg-primary [overflow-wrap:anywhere]">
                        {personName(access.owner, ownerLabel)}
                        {viewerIsOwner && <span className="font-normal text-fg-muted"> (you)</span>}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-surface-hover px-2 py-0.5 text-xs font-medium text-fg-secondary">
                      Owner
                    </span>
                  </li>
                  {grants.map((grant) => (
                    <GrantRow
                      key={grant.id}
                      grant={grant}
                      viewerUserId={viewerUserId}
                      now={now}
                      canManage={canManage}
                      canRenew={access.viewerAccess === 'owner'}
                      cascades={hasDownstreamGrants(grants, grant)}
                      confirmingRemoval={pendingRemovalId === grant.grantee.id}
                      removing={
                        revokeMutation.isPending &&
                        revokeMutation.variables?.grantee.id === grant.grantee.id
                      }
                      busy={revokeMutation.isPending}
                      error={
                        pendingRemovalId === grant.grantee.id && revokeMutation.error
                          ? errorMessage(revokeMutation.error)
                          : null
                      }
                      onAskRemove={() => {
                        revokeMutation.reset();
                        setNotice(null);
                        setPendingRemovalId(grant.grantee.id);
                      }}
                      onCancelRemove={() => {
                        revokeMutation.reset();
                        setPendingRemovalId(null);
                      }}
                      onConfirmRemove={() => revokeMutation.mutate(grant)}
                      onRenew={() =>
                        startConfirm({
                          userId: grant.grantee.id,
                          name: personName(grant.grantee, 'this teammate'),
                          renewing: true,
                        })
                      }
                    />
                  ))}
                </ul>
                {grants.length === 0 && (
                  <p className="m-0 mt-2 text-xs text-fg-muted">
                    Only the owner can use this chat right now.
                  </p>
                )}
              </section>

              {canManage && canAddPeople && (
                <AddTeammateSection
                  projectId={projectId}
                  ownerUserId={access.owner?.id ?? null}
                  viewerUserId={viewerUserId}
                  grants={access.grants}
                  onPick={(member: ProjectMemberSummary) =>
                    startConfirm({
                      userId: member.userId,
                      name: memberLabel(member),
                      renewing: false,
                    })
                  }
                />
              )}
              {canManage && !canAddPeople && (
                <p className="m-0 mt-5 text-sm text-fg-muted">
                  This chat has ended, so no one else can be added.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
