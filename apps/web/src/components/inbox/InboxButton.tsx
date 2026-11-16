import type { InboxItem } from '@simple-agent-manager/shared';
import { IconButton } from '@simple-agent-manager/ui';
import { Inbox } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { importWithRetry } from '../../lib/lazy-with-retry';
import { useInboxCount } from './useInbox';

// The icon lives in the app shell on every page; the quick view (and the answer code behind it)
// loads only when someone opens it, so it stays out of the main bundle.
const loadQuickView = () => importWithRetry(() => import('./InboxQuickView'));
const InboxQuickView = lazy(() =>
  loadQuickView().then((module) => ({ default: module.InboxQuickView }))
);

/** The cross-project Inbox page, opened on one item when given. */
export function inboxPath(item?: InboxItem): string {
  if (!item) return '/inbox';
  const params = new URLSearchParams({ item: item.ref, project: item.projectId });
  return `/inbox?${params.toString()}`;
}

/**
 * The inbox icon in the old bell's slot. Its badge counts what the viewer can act on across every
 * project. Desktop: a quick view with safe one-tap answers. Phone: opens the Inbox page.
 */
export function InboxButton() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const count = useInboxCount(null).data?.needsYou ?? 0;
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({});
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setStyle({ top: rect.bottom + 8, left: Math.max(16, rect.left) });
  }, [open]);

  // Two refs (the icon and the portaled panel), so the single-ref `useClickOutside` from
  // packages/ui does not fit.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Crossing to the phone layout closes the quick view (the icon becomes a link there).
  useEffect(() => {
    if (isMobile) setOpen(false);
  }, [isMobile]);

  const label = count > 0 ? `Inbox, ${count} need${count === 1 ? 's' : ''} you` : 'Inbox';

  return (
    <div className="relative">
      <IconButton
        ref={buttonRef}
        onClick={() => (isMobile ? navigate('/inbox') : setOpen((value) => !value))}
        onPointerEnter={isMobile ? undefined : () => void loadQuickView()}
        onFocus={isMobile ? undefined : () => void loadQuickView()}
        label={label}
        icon={<Inbox size={20} strokeWidth={1.75} />}
        count={count > 99 ? '99+' : count || undefined}
        countTone="attention"
        aria-expanded={isMobile ? undefined : open}
        aria-haspopup={isMobile ? undefined : 'dialog'}
        showTooltip={false}
      />
      {open &&
        createPortal(
          <Suspense fallback={null}>
            <InboxQuickView
              ref={panelRef}
              style={style}
              total={count}
              onClose={close}
              onOpenItem={(item) => {
                setOpen(false);
                navigate(inboxPath(item));
              }}
              onOpenInbox={() => {
                setOpen(false);
                navigate(inboxPath());
              }}
            />
          </Suspense>,
          document.body
        )}
    </div>
  );
}
