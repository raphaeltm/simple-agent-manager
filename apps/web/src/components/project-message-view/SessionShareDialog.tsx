import type {
  RevokeSessionAccessGrantResponse,
  SessionAccessGrant,
  SessionAccessSummary,
} from '@simple-agent-manager/shared';
import { Avatar, Button, useModalInteraction } from '@simple-agent-manager/ui';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Users, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ProjectMemberSummary } from '../../hooks/useProjectMembers';
import { revokeSessionAccess, shareSessionAccess } from '../../lib/api/session-access';
import { AddTeammateSection, memberLabel } from './SessionShareAddTeammate';
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

/** How the dialog talks about the owner, from the viewer's side: "your" when it is them. */
interface OwnerWords {
  /** "your" / "Prakash's" */
  possessive: string;
  /** "you" / "Prakash" — who agents are billed to. */
  object: string;
  /** "my" / "Prakash's" — for the acknowledgement the viewer ticks. */
  firstPersonPossessive: string;
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
 * "Share chat access" — give a teammate owner-equivalent control of one chat session.
 *
 * Everything a person added here does runs on the owner's accounts (agent credential, GitHub
 * identity, compute), and the agent can read the owner's keys. The dialog says that in plain
 * words and requires an explicit acknowledgement before sharing; the server enforces the same
 * acknowledgement and the other rules (active membership, grant limit). Once shared, the
 * teammate's messages are handled exactly like the owner's.
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
  const [confirming, setConfirming] = useState<ProjectMemberSummary | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useModalInteraction({ enabled: true, modalRef: panelRef, onEscape: onClose });

  const viewerIsOwner = access.viewerAccess === 'owner' || access.owner?.id === viewerUserId;
  const canManage = access.viewerAccess === 'owner' || access.viewerAccess === 'grantee';
  const words = ownerWords(viewerIsOwner, ownerLabel);
  const grants = [...access.grants].sort((a, b) => a.createdAt - b.createdAt);

  const shareMutation = useMutation({
    mutationFn: (member: ProjectMemberSummary) =>
      shareSessionAccess(projectId, sessionId, member.userId),
    onSuccess: (response, member) => {
      onChanged(response.access);
      setConfirming(null);
      const name = memberLabel(member);
      setNotice(
        response.created ? `${name} can now use this chat.` : `${name} already had access.`
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

  const startConfirm = (member: ProjectMemberSummary) => {
    shareMutation.reset();
    setAcknowledged(false);
    setNotice(null);
    setPendingRemovalId(null);
    setConfirming(member);
  };

  const backToList = () => {
    shareMutation.reset();
    setConfirming(null);
    panelRef.current?.focus();
  };

  const confirmName = confirming ? memberLabel(confirming) : '';

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
              ? `People you add can message the agent and manage this chat, just like you. It runs on ${words.possessive} accounts.`
              : `The people below can message the agent and manage this chat, just like the owner. It runs on ${words.possessive} accounts.`}
          </p>

          {confirming ? (
            <section aria-labelledby={`${titleId}-confirm`} className="mt-4">
              <h3
                id={`${titleId}-confirm`}
                ref={confirmHeadingRef}
                tabIndex={-1}
                className="m-0 text-sm font-semibold text-fg-primary focus:outline-none [overflow-wrap:anywhere]"
              >
                Share with {confirmName}?
              </h3>
              <ul className="mt-2 mb-0 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-fg-primary">
                <li>
                  {confirmName} can send messages, stop or archive the chat, and answer the agent —
                  just like you.
                </li>
                <li>
                  Everything runs on {words.possessive} accounts: AI subscription or API key, GitHub
                  access and compute. Agents it starts are billed to {words.object}.
                </li>
                <li>
                  The agent can read {words.possessive} keys, so {confirmName} may be able to see
                  them. Only share with people you trust.
                </li>
                <li>There&apos;s no end date. You can remove access at any time.</li>
              </ul>
              <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-default bg-inset px-3 py-2.5 text-sm text-fg-primary">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
                />
                <span>I understand this runs on {words.firstPersonPossessive} accounts</span>
              </label>
              {shareMutation.error && (
                <p
                  role="alert"
                  className="mt-3 mb-0 rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-sm text-danger-fg [overflow-wrap:anywhere]"
                >
                  {errorMessage(shareMutation.error)}
                </p>
              )}
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={backToList} disabled={shareMutation.isPending}>
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back
                </Button>
                <Button
                  onClick={() => shareMutation.mutate(confirming)}
                  disabled={!acknowledged}
                  loading={shareMutation.isPending}
                >
                  Share
                </Button>
              </div>
            </section>
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
                      canManage={canManage}
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
                  onPick={startConfirm}
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
