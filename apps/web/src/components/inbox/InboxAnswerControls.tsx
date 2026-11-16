import type { InboxItem } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { MessageSquare, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';

import { answerInboxItem } from '../../lib/api';
import { projectChatPath } from '../../lib/project-routes';
import { AttentionAnswerControls } from '../notifications/AttentionAnswerControls';
import { ApprovalDecisionButtons } from '../operations-approvals/ApprovalItem';
import { PermissionOptions } from '../project-message-view/AcpPermissionOptions';
import { SecretRequestForm } from '../project-message-view/tool-cards/SecretRequestForm';
import { useSecretRequest } from '../project-message-view/tool-cards/useSecretRequest';
import type {
  PermissionDetail,
  PermissionOption,
} from '../project-message-view/useAcpPermissionCard';
import {
  deliveryNote,
  errorText,
  type InboxAnswerHandlers,
  isStaleInboxError,
  type useInboxPermissionDetail,
  useInboxSend,
} from './inbox-actions';
import { isIrreversibleApproval } from './inbox-model';

/** What the agent wants to run lives in the body; only the buttons are pinned. */
export function InboxPermissionSummary({ detail }: { detail: PermissionDetail | null }) {
  if (!detail) return null;
  return (
    <div className="sam-well flex min-w-0 flex-col gap-1 rounded-xl px-3 py-2.5">
      <code className="font-mono text-[13px] whitespace-pre-wrap break-words text-fg-primary [overflow-wrap:anywhere]">
        {detail.title}
      </code>
      {detail.description && (
        <span className="text-[13px] whitespace-pre-wrap break-words text-fg-muted [overflow-wrap:anywhere]">
          {detail.description}
        </span>
      )}
    </div>
  );
}

function OpenChatButton({ item, label }: { item: InboxItem; label: string }) {
  if (!item.sessionId) return null;
  return (
    <Link
      to={projectChatPath(item.projectId, item.sessionId)}
      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-default px-4 text-sm font-semibold text-fg-primary no-underline hover:bg-[var(--sam-glass-v2-raised)]"
    >
      <MessageSquare size={16} aria-hidden="true" /> {label}
    </Link>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="m-0 text-sm text-danger-fg [overflow-wrap:anywhere]">
      {error}
    </p>
  );
}

function PermissionControls({
  item,
  permission,
  handlers,
}: {
  item: InboxItem;
  permission: ReturnType<typeof useInboxPermissionDetail>;
  handlers: InboxAnswerHandlers;
}) {
  const { busy, error, send } = useInboxSend(item, handlers);
  if (permission.state === 'loading' || permission.state === 'idle')
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        Loading the request…
      </p>
    );
  if (permission.state !== 'ready' || !permission.detail)
    return (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="m-0 text-sm text-warning-fg">
          {permission.state === 'revoked'
            ? 'You no longer have access to answer this request.'
            : 'The request details are unavailable. No option was inferred.'}
        </p>
        {permission.state === 'error' && (
          <Button size="sm" variant="ghost" onClick={permission.retry} className="min-h-11">
            <RefreshCw size={14} aria-hidden="true" /> Retry
          </Button>
        )}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <PermissionOptions
        layout="pinned"
        options={permission.detail.options}
        disabled={busy !== null}
        busyOptionId={busy}
        onChoose={(option: PermissionOption) =>
          void send(
            option.id,
            { optionId: option.id },
            (r) => `Sent “${option.name}”${deliveryNote(r)}`
          )
        }
      />
      <ErrorLine error={error} />
    </div>
  );
}

function SecretControls({ item, handlers }: { item: InboxItem; handlers: InboxAnswerHandlers }) {
  const requestId = item.answerSpec.type === 'secret' ? item.answerSpec.requestId : '';
  const { query } = useSecretRequest(item.projectId, requestId);
  if (!query.data) {
    if (query.error && isStaleInboxError(query.error)) {
      return <StaleNotice onStale={handlers.onStale} />;
    }
    return query.error ? (
      <div className="flex flex-wrap items-center gap-2" role="alert">
        <p className="m-0 text-sm text-danger-fg">
          {errorText(query.error, 'Could not load this request')}
        </p>
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()} className="min-h-11">
          Retry
        </Button>
      </div>
    ) : (
      <p role="status" className="m-0 text-sm text-fg-muted">
        Loading the request…
      </p>
    );
  }
  const { request } = query.data;
  if (request.status !== 'pending') return <StaleNotice onStale={handlers.onStale} />;
  if (!query.data.canResolve)
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        Only the person who started this chat or a project admin can supply this value.
      </p>
    );
  return (
    <SecretRequestForm
      projectId={item.projectId}
      request={request}
      existing={query.data.existing}
      onResolved={(resolution) => {
        const verb = resolution.request.status === 'fulfilled' ? 'Saved' : 'Declined';
        handlers.onAnswered(
          `${verb} ${request.envKey}${resolution.agentNotified ? '' : ' · the agent will be told shortly'}`
        );
      }}
    />
  );
}

/** A closed request found while loading its controls closes the item by itself. */
function StaleNotice({ onStale }: { onStale: () => void }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    onStale();
  }, [onStale]);
  return (
    <p role="status" className="m-0 text-sm text-fg-muted">
      This was already handled.
    </p>
  );
}

function ReviewControls({ item, handlers }: { item: InboxItem; handlers: InboxAnswerHandlers }) {
  const { busy, error, send } = useInboxSend(item, handlers);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {replying ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const reply = text.trim();
            if (reply)
              void send('reply', { answer: reply }, (r) => `Sent your reply${deliveryNote(r)}`);
          }}
        >
          <label htmlFor={`reply-${item.ref}`} className="text-xs text-fg-muted">
            Your reply
          </label>
          <textarea
            id={`reply-${item.ref}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            disabled={busy !== null}
            className="w-full min-w-0 rounded-md border border-border-default bg-inset p-2 text-base text-fg-primary sm:text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={!text.trim() || busy !== null}
              className="min-h-11"
            >
              {busy === 'reply' ? 'Sending…' : 'Send reply'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setReplying(false)}
              className="min-h-11"
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <Button
            disabled={busy !== null}
            onClick={() => void send('ack', {}, (r) => `Marked “Looks good”${deliveryNote(r)}`)}
            className="min-h-11"
          >
            {busy === 'ack' ? 'Sending…' : 'Looks good'}
          </Button>
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => setReplying(true)}
            className="min-h-11"
          >
            Reply
          </Button>
        </div>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function ApprovalControls({ item, handlers }: { item: InboxItem; handlers: InboxAnswerHandlers }) {
  const { busy, error, send } = useInboxSend(item, handlers);
  const irreversible = isIrreversibleApproval(item.answerSpec);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ApprovalDecisionButtons
        irreversible={irreversible}
        deciding={busy === 'approve' || busy === 'deny' ? busy : null}
        onDecide={(decision) =>
          void send(
            decision,
            { decision },
            (r) => `${decision === 'approve' ? 'Approved' : 'Denied'}${deliveryNote(r)}`
          )
        }
      />
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * The pinned answer area of an inbox item, chosen by `answerSpec.type` so every kind is handled
 * generically. Every answer goes to the record the agent reads, through the slice A routes (the
 * secret form keeps its own route to the same request, so the value never enters a cache).
 */
export function InboxAnswerControls({
  item,
  permission,
  handlers,
}: {
  item: InboxItem;
  permission: ReturnType<typeof useInboxPermissionDetail>;
  handlers: InboxAnswerHandlers;
}) {
  if (item.status !== 'open')
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        This item is {item.status}.
      </p>
    );
  if (!item.canAct)
    return (
      <p role="status" className="m-0 text-sm text-fg-muted">
        You can read this item, but someone else answers it.
      </p>
    );
  const spec = item.answerSpec;
  switch (spec.type) {
    case 'options':
    case 'text':
      return (
        <AttentionAnswerControls
          key={item.ref}
          layout="pinned"
          projectId={item.projectId}
          sessionId={item.sessionId ?? ''}
          markerId={item.ref}
          options={spec.type === 'options' ? spec.options : []}
          allowCustom={spec.type === 'text' || spec.allowText}
          submit={async (answer) => {
            try {
              const response = await answerInboxItem(item.projectId, item.ref, { answer });
              handlers.onAnswered(`Sent “${answer}”${deliveryNote(response)}`);
              return { answer, resolved: response.outcome !== 'in_flight' };
            } catch (cause) {
              if (isStaleInboxError(cause)) {
                handlers.onStale();
                return { answer, resolved: true };
              }
              throw cause;
            }
          }}
        />
      );
    case 'interaction':
      return spec.interactionKind === 'permission' ? (
        <PermissionControls
          key={item.ref}
          item={item}
          permission={permission}
          handlers={handlers}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 text-sm text-fg-muted">This request is answered in its chat.</p>
          <OpenChatButton item={item} label="Answer in chat" />
        </div>
      );
    case 'secret':
      return <SecretControls key={item.ref} item={item} handlers={handlers} />;
    case 'approval':
      return <ApprovalControls key={item.ref} item={item} handlers={handlers} />;
    case 'acknowledge':
      if (item.kind === 'review')
        return <ReviewControls key={item.ref} item={item} handlers={handlers} />;
      // Human tasks and SAM's own error items are read-only here until their slices ship.
      return item.sessionId ? <OpenChatButton item={item} label="Open chat" /> : null;
  }
}
