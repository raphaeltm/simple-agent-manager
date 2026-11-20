import type { InboxItem } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';

import { INBOX_FROM_PARAM } from '../../lib/project-routes';
import { isStaleInboxError } from './inbox-actions';
import { type InboxView, nextAfter, parseInboxView, walkOrder } from './inbox-model';
import type { InboxReceipt } from './InboxItemView';
import { useInboxItem, useInboxList, useInvalidateInbox, usePendingArchive } from './useInbox';

/** How long an answer receipt stays before it fades. Override with VITE_INBOX_RECEIPT_MS. */
const DEFAULT_INBOX_RECEIPT_MS = 4_000;
const configuredReceiptMs = Number.parseInt(import.meta.env.VITE_INBOX_RECEIPT_MS ?? '', 10);
const INBOX_RECEIPT_MS =
  Number.isFinite(configuredReceiptMs) && configuredReceiptMs > 0
    ? configuredReceiptMs
    : DEFAULT_INBOX_RECEIPT_MS;

/**
 * The inbox walk: which view and item are open (both in the URL, so phone Back returns to the
 * list), previous / next, answering, archiving with Undo and closing stale items.
 *
 * Interaction-effect trace (rule 06): the URL `item` param is written only by handlers (open,
 * previous/next, advance, undo, chip change). The only effect that reacts to selection is the
 * stale check, which writes the URL once per ref (guarded by `staleHandled`), so it cannot undo
 * a handler's navigation or loop. Desktop's default selection (the first item) is derived, not
 * written, so nothing races the user's first tap.
 */
export function useInboxWalk({
  projectId,
  isMobile,
}: {
  projectId: string | null;
  isMobile: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // A replace keeps the entry's history state (it is the same entry); a push starts clean.
  const entryStateRef = useRef<unknown>(location.state);
  entryStateRef.current = location.state;
  const view = parseInboxView(params.get('filter'));
  const itemParam = params.get('item');
  const projectParam = projectId ?? params.get('project');
  const invalidate = useInvalidateInbox();

  const list = useInboxList(projectId, view === 'updates' ? 'needs_you' : view, view !== 'updates');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  // `hidden` holds what this session answered or archived until the server list catches up. The
  // Archived view lists exactly those archives, so it must not filter them out.
  const order = useMemo(
    () =>
      walkOrder(
        view === 'archived' ? list.items : list.items.filter((item) => !hidden.has(item.ref))
      ),
    [list.items, hidden, view]
  );
  const orderRef = useRef(order);
  orderRef.current = order;

  // Where each answered or archived item handed over to. The URL catches up a render later; until
  // then the hidden ref in the URL resolves to its successor, so no "nothing open" frame flashes.
  const handedOver = useRef(new Map<string, string | null>());
  const effectiveParam =
    itemParam && hidden.has(itemParam) && handedOver.current.has(itemParam)
      ? (handedOver.current.get(itemParam) ?? null)
      : itemParam;
  const selectedRef =
    effectiveParam ?? (!isMobile && view !== 'updates' ? (order[0]?.ref ?? null) : null);
  const listed = order.find((item) => item.ref === selectedRef) ?? null;
  const detail = useInboxItem(
    listed?.projectId ?? projectParam,
    selectedRef && !hidden.has(selectedRef) ? selectedRef : null
  );
  const selected: InboxItem | null =
    listed ?? (detail.data && detail.data.item.ref === selectedRef ? detail.data.item : null);

  const [receipt, setReceipt] = useState<(InboxReceipt & { archivedRef?: string }) | null>(null);
  const receiptSeq = useRef(0);
  const showReceipt = useCallback(
    (text: string, tone: InboxReceipt['tone'], archivedRef?: string) => {
      receiptSeq.current += 1;
      setReceipt({ id: receiptSeq.current, text, tone, archivedRef });
    },
    []
  );
  useEffect(() => {
    // An error stays until dismissed: the person must not miss why an item came back.
    if (!receipt || receipt.tone === 'error') return;
    const id = receipt.id;
    const ms = receipt.archivedRef ? INBOX_RECEIPT_MS + 1_000 : INBOX_RECEIPT_MS;
    const timer = setTimeout(
      () => setReceipt((current) => (current?.id === id ? null : current)),
      ms
    );
    return () => clearTimeout(timer);
  }, [receipt]);

  const navigateTo = useCallback(
    (item: InboxItem | null, replace: boolean) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (item) {
            next.set('item', item.ref);
            if (projectId) next.delete('project');
            else next.set('project', item.projectId);
          } else {
            next.delete('item');
            next.delete('project');
          }
          return next;
        },
        { replace, state: replace ? entryStateRef.current : undefined }
      );
    },
    [projectId, setParams]
  );

  const setView = useCallback(
    (next: InboxView) => {
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          if (next === 'needs_you') out.delete('filter');
          else out.set('filter', next);
          out.delete('item');
          out.delete('project');
          // Browsing the inbox by chip: Back from the next item returns to the list, not to the
          // page that opened the first one.
          out.delete(INBOX_FROM_PARAM);
          return out;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  /** Take `ref` out of the walk and open what comes after it (or nothing: the empty state). */
  const advancePast = useCallback(
    (ref: string) => {
      const next = nextAfter(orderRef.current, ref);
      handedOver.current.set(ref, next?.ref ?? null);
      setHidden((current) => new Set(current).add(ref));
      navigateTo(next, true);
    },
    [navigateTo]
  );

  const unhide = useCallback((ref: string) => {
    setHidden((current) => {
      const next = new Set(current);
      next.delete(ref);
      return next;
    });
  }, []);

  const onAnswered = useCallback(
    (ref: string, text: string) => {
      showReceipt(text, 'success');
      advancePast(ref);
      invalidate();
    },
    [advancePast, invalidate, showReceipt]
  );

  /**
   * A reply went to the agent's chat. The item leaves Needs you (the server hides it until the
   * agent acts), so the walk moves on as after an answer. In Archived, where items with the agent
   * are listed, it stays open and refreshes to show the reply.
   */
  const onReplied = useCallback(
    (ref: string, text: string) => {
      if (view === 'archived') {
        showReceipt(text, 'success');
        invalidate();
        return;
      }
      onAnswered(ref, text);
    },
    [invalidate, onAnswered, showReceipt, view]
  );

  const staleHandled = useRef(new Set<string>());
  const onStale = useCallback(
    (ref: string) => {
      if (staleHandled.current.has(ref)) return;
      staleHandled.current.add(ref);
      showReceipt('Already handled somewhere else', 'success');
      advancePast(ref);
      invalidate();
    },
    [advancePast, invalidate, showReceipt]
  );

  // Answered or closed elsewhere (another tab, the chat card, a teammate): close it. A settled
  // item that still takes replies (a permission declined by a reply, then responded on) is a
  // conversation, not a closed item.
  useEffect(() => {
    if (!selectedRef || view === 'archived') return;
    const closed =
      (detail.error && isStaleInboxError(detail.error)) ||
      (detail.data &&
        detail.data.item.ref === selectedRef &&
        detail.data.item.status !== 'open' &&
        detail.data.item.canReply !== true);
    if (closed) onStale(selectedRef);
  }, [detail.data, detail.error, onStale, selectedRef, view]);

  const {
    pending: pendingArchive,
    schedule: scheduleArchive,
    undo: undoPendingArchive,
  } = usePendingArchive({
    onSent: invalidate,
    onFailed: (item, error) => {
      if (isStaleInboxError(error)) {
        invalidate();
        return;
      }
      unhide(item.ref);
      showReceipt(
        `Could not archive “${item.title}”: ${error instanceof Error ? error.message : 'request failed'}`,
        'error'
      );
    },
  });

  const archiveItem = useCallback(
    (item: InboxItem) => {
      advancePast(item.ref);
      scheduleArchive(item);
      showReceipt('Archived', 'success', item.ref);
    },
    [advancePast, scheduleArchive, showReceipt]
  );

  const undoArchive = useCallback(() => {
    const restored = undoPendingArchive();
    if (!restored) return;
    unhide(restored.ref);
    navigateTo(restored, true);
    setReceipt(null);
  }, [navigateTo, undoPendingArchive, unhide]);

  const open = useCallback((item: InboxItem) => navigateTo(item, false), [navigateTo]);
  const step = useCallback((item: InboxItem) => navigateTo(item, true), [navigateTo]);
  const close = useCallback(() => navigateTo(null, false), [navigateTo]);

  const visibleReceipt: InboxReceipt | null = receipt
    ? {
        id: receipt.id,
        text: receipt.text,
        tone: receipt.tone,
        onUndo:
          receipt.archivedRef && pendingArchive?.ref === receipt.archivedRef
            ? undoArchive
            : undefined,
        onDismiss: receipt.tone === 'error' ? () => setReceipt(null) : undefined,
      }
    : null;

  return {
    view,
    setView,
    list,
    order,
    selected,
    selectedRef,
    itemParam: effectiveParam,
    detail,
    receipt: visibleReceipt,
    open,
    step,
    close,
    onAnswered,
    onReplied,
    onStale,
    archiveItem,
  };
}
