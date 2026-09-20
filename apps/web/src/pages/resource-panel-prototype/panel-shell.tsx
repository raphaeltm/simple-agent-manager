/**
 * The sibling-drawer geometry, copied verbatim from `SessionCommentsDrawer`.
 *
 * Why a `<dialog>` and not a `<div role="dialog">`: the production Resources
 * panel is already a `<dialog>`, and Step 0 measured that the element type is
 * not the bug — the MISSING EXPLICIT HEIGHT is. The UA sheet gives `dialog`
 * `height: fit-content`, so `inset-0` + `max-h-none` produced a 1069px-tall
 * dialog inside a 667px viewport, `overflow-hidden` clipped the overhang, and
 * the `flex-1 min-h-0 overflow-y-auto` body never overflowed (scrollHeight 996
 * === clientHeight 996, scrollTop pinned at 0). Comments' `h-[100dvh]
 * max-h-[100dvh]` measured 667px with a body of 1510/577 that scrolls. So:
 * keep the `<dialog>`, pin the height.
 */
import { Activity, X } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

export function ResourcePanelShell({
  panelRef,
  onClose,
  children,
  bodyClassName = 'flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 space-y-3',
  belowHeader,
  testId,
}: Readonly<{
  panelRef: RefObject<HTMLDialogElement | null>;
  onClose: () => void;
  children: ReactNode;
  bodyClassName?: string;
  /** Sticky chrome between the header and the scrolling body (variant C). */
  belowHeader?: ReactNode;
  testId: string;
}>) {
  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      <dialog
        open
        ref={panelRef}
        tabIndex={-1}
        aria-modal="true"
        aria-label="Session resources"
        data-testid={testId}
        className="glass-panel-container glass-composited fixed z-50 glass-modal m-0 box-border h-[100dvh] w-[100dvw] max-h-[100dvh] max-w-[100dvw] rounded-none border-0 p-0 text-inherit backdrop:bg-transparent flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:h-auto md:w-[min(460px,55vw)] md:max-w-[min(460px,55vw)] md:rounded-l-[20px] md:rounded-r-none md:border-y-0 md:border-r-0 md:border-l
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(96,165,250,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
      >
        <ResourcePanelHeader onClose={onClose} />
        {belowHeader}
        <div className={bodyClassName} data-testid={`${testId}-body`}>
          {children}
        </div>
      </dialog>
    </>,
    document.body
  );
}

/** Header, matching the siblings down to the `p-1.5` close button. */
export function ResourcePanelHeader({ onClose }: Readonly<{ onClose: () => void }>) {
  return (
    <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
      <Activity size={16} className="text-fg-muted shrink-0" />
      <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Resources</h2>
      <button
        type="button"
        onClick={onClose}
        className="p-1.5 rounded hover:bg-surface-hover text-fg-muted hover:text-fg-primary transition-colors"
        aria-label="Close resources"
      >
        <X size={16} />
      </button>
    </header>
  );
}
