import type { InboxItem } from '@simple-agent-manager/shared';
import { Button, IconButton, paneClassName, Spinner } from '@simple-agent-manager/ui';
import { ArrowRight, Check, X } from 'lucide-react';
import { forwardRef, useMemo, useState } from 'react';

import { useMinuteClock } from '../../hooks/useMinuteClock';
import type { answerInboxItem } from '../../lib/api';
import { deliveryNote, useInboxPermissionDetail, useInboxSend } from './inbox-actions';
import { buildRows } from './inbox-model';
import { InboxPushInvite } from './InboxPushInvite';
import { InboxEmptyState, InboxRow } from './InboxRow';
import { useInboxList, useInvalidateInbox } from './useInbox';

/** Rows the quick view lists before "Open inbox". */
const QUICK_VIEW_LIMIT = 8;
/** One-tap option answers only when every option is this short (a longer one needs reading). */
const ONE_TAP_OPTION_MAX_CHARS = 24;
/** And only for this many options or fewer. */
const ONE_TAP_MAX_OPTIONS = 3;

type OneTap = { label: string; body: Parameters<typeof answerInboxItem>[2]; primary?: boolean };

/** Option and review answers that are safe in one tap; permissions are handled separately. */
function staticOneTaps(item: InboxItem): OneTap[] {
  if (!item.canAct || item.status !== 'open') return [];
  const spec = item.answerSpec;
  if (
    spec.type === 'options' &&
    spec.options.length > 0 &&
    spec.options.length <= ONE_TAP_MAX_OPTIONS &&
    spec.options.every((option) => option.length <= ONE_TAP_OPTION_MAX_CHARS)
  ) {
    return spec.options.map((option) => ({ label: option, body: { answer: option } }));
  }
  if (spec.type === 'acknowledge' && item.kind === 'review') {
    return [{ label: 'Looks good', body: {}, primary: true }];
  }
  return [];
}

function OneTapButtons({ item, taps }: { item: InboxItem; taps: OneTap[] }) {
  const invalidate = useInvalidateInbox();
  const [done, setDone] = useState<string | null>(null);
  const handlers = useMemo(
    () => ({
      onAnswered: (receipt: string) => {
        setDone(receipt);
        invalidate();
      },
      onStale: () => {
        setDone('Already handled somewhere else');
        invalidate();
      },
    }),
    [invalidate]
  );
  const { busy, error, send } = useInboxSend(item, handlers);
  if (taps.length === 0) return null;
  if (done)
    return (
      <p
        role="status"
        className="m-0 flex items-center gap-1.5 px-3 pb-2.5 pl-14 text-sm text-[var(--sam-status-success-fg)]"
      >
        <Check size={14} aria-hidden="true" /> {done}
      </p>
    );
  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5 pl-14">
      <div className="flex flex-wrap gap-2">
        {taps.map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            variant={choice.primary ? 'primary' : 'secondary'}
            disabled={busy !== null}
            onClick={() =>
              void send(
                choice.label,
                choice.body,
                (r) => `Sent “${choice.label}”${deliveryNote(r)}`
              )
            }
            className="min-h-11 max-w-full !whitespace-normal break-words"
          >
            {busy === choice.label ? 'Sending…' : choice.label}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="m-0 text-xs text-danger-fg [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </div>
  );
}

/** Allow / Deny for a live permission: only the once-options, never "always". */
function PermissionOneTap({ item }: { item: InboxItem }) {
  const permission = useInboxPermissionDetail(item);
  const taps = useMemo<OneTap[]>(() => {
    const options = permission.detail?.options ?? [];
    const allow = options.find((option) => option.kind === 'allow_once');
    const deny = options.find((option) => option.kind === 'reject_once');
    if (!allow || !deny) return [];
    return [
      { label: allow.name, body: { optionId: allow.id }, primary: true },
      { label: deny.name, body: { optionId: deny.id } },
    ];
  }, [permission.detail]);
  return <OneTapButtons item={item} taps={taps} />;
}

function QuickAnswers({ item }: { item: InboxItem }) {
  const spec = item.answerSpec;
  if (spec.type === 'interaction' && spec.interactionKind === 'permission' && item.canAct)
    return <PermissionOneTap item={item} />;
  return <OneTapButtons item={item} taps={staticOneTaps(item)} />;
}

/**
 * The desktop quick view behind the inbox icon: the first items across every project, one-tap
 * answers only where one tap is safe (Allow / Deny, three or fewer short options, "Looks good"),
 * and a link to the full inbox. Everything else opens the item on the Inbox page.
 */
export const InboxQuickView = forwardRef<
  HTMLDivElement,
  {
    style: React.CSSProperties;
    total: number | undefined;
    onClose: () => void;
    onOpenItem: (item: InboxItem) => void;
    onOpenInbox: () => void;
  }
>(function InboxQuickView({ style, total, onClose, onOpenItem, onOpenInbox }, ref) {
  const now = useMinuteClock();
  const list = useInboxList(null, 'needs_you');
  const rows = useMemo(() => buildRows(list.items).slice(0, QUICK_VIEW_LIMIT), [list.items]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Inbox quick view"
      style={style}
      className={`${paneClassName('overlay')} fixed z-[100] flex max-h-[min(640px,calc(100vh-5rem))] w-[420px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--sam-hairline)] px-4 py-2">
        <h2 className="m-0 text-[15px] font-semibold text-fg-primary">Inbox</h2>
        {total !== undefined && total > 0 && (
          <span className="font-mono text-xs text-warning-fg">{total}</span>
        )}
        <span className="flex-1 text-xs text-fg-muted">all projects</span>
        <IconButton
          label="Close inbox quick view"
          icon={<X size={16} />}
          onClick={onClose}
          showTooltip={false}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <InboxPushInvite />
        {!list.loaded ? (
          <div className="flex justify-center py-8" role="status" aria-label="Loading inbox">
            <Spinner size="sm" />
          </div>
        ) : rows.length === 0 ? (
          <InboxEmptyState />
        ) : (
          <ul className="m-0 flex flex-col gap-1 p-2">
            {rows.map((row) => (
              <InboxRow key={row.key} row={row} showProject now={now} onOpen={onOpenItem}>
                {row.type === 'item' && <QuickAnswers item={row.item} />}
              </InboxRow>
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--sam-hairline)] p-2">
        <Button variant="secondary" onClick={onOpenInbox} className="min-h-11 w-full">
          Open inbox <ArrowRight size={16} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
});
