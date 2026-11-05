import { IconButton, paneClassName } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import { type ReactNode, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useDialogFocusTrap } from '../chat/useDialogFocusTrap';

/**
 * The phone's session-info sheet: everything the one-line mobile header leaves out (chips,
 * ports, the public-ports switch and the full details panel) in a bottom sheet.
 *
 * A bottom sheet rather than the rail's right-side drawers: it is opened from the header's
 * title, where the thumb already is, and it reads top to bottom like the header it expands.
 * It is the only overlay open at a time, so it carries the screen's one live blur (SAM Glass
 * `overlay`); the scrim only dims. It slides with `transform` only, so opening it never
 * re-lays out the conversation underneath.
 */
export function SessionInfoSheet({
  title,
  people,
  onClose,
  children,
}: Readonly<{
  title: string;
  /** Avatars of everyone with access, shown beside the title. */
  people?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocusTrap(panelRef, onClose);

  return createPortal(
    <>
      <div
        role="presentation"
        onClick={onClose}
        data-testid="session-info-sheet-backdrop"
        className="sam-scrim sam-sheet-backdrop fixed inset-0 z-drawer-backdrop"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-sam-modal-root=""
        data-testid="session-info-sheet"
        className={`${paneClassName('overlay', { rounded: false })} sam-sheet-panel fixed inset-x-0 bottom-0 z-drawer flex max-h-[88dvh] flex-col overflow-hidden rounded-t-[var(--sam-radius-pane)] outline-none`}
      >
        <div
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--sam-hairline)]"
        />
        {/* The close button stays put; the title scrolls with the content, so a long title
            cannot pin half the sheet. */}
        <div className="absolute top-3 right-2 z-10">
          <IconButton
            label="Close session info"
            icon={<X size={20} strokeWidth={1.75} />}
            onClick={onClose}
            showTooltip={false}
          />
        </div>
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[max(16px,env(safe-area-inset-bottom))]">
          <header className="flex items-start gap-2 pt-2 pr-14 pb-1 pl-4">
            <h2
              id={titleId}
              className="m-0 min-w-0 flex-1 pt-2.5 text-[17px] leading-snug font-semibold text-fg-primary [overflow-wrap:anywhere]"
            >
              {title}
            </h2>
            {people}
          </header>
          {children}
        </div>
      </div>
    </>,
    document.body
  );
}
