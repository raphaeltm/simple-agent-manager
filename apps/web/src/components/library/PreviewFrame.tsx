/**
 * The Library viewer's outer chrome, shared by the loaded viewer (`FilePreviewModal`) and its
 * loading frame (`LibraryFilePreview`), so both open in the same place.
 *
 * - `screen`: the viewer is its own screen, a void with the header slab and the artifact pane on
 *   it. The Library page uses this; so does every phone, where a preview is full screen.
 * - `overlay`: on a wider screen the viewer floats over the page that referenced the file, in a
 *   live glass overlay over a scrim, so the person can see where closing it returns them.
 */
import { paneClassName } from '@simple-agent-manager/ui';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';

import { useIsMobile } from '../../hooks/useIsMobile';

export type PreviewPresentation = 'screen' | 'overlay';

// Matches the `data-library-preview-root` attribute every viewer root carries.
const ROOT_ATTRIBUTE = 'data-library-preview-root';

/**
 * Whether `dialog` belongs to the most recently opened viewer. A markdown file can link another
 * Library file, which opens a second viewer over the first; Escape closes only the top one.
 */
export function isTopmostPreview(dialog: HTMLElement | null): boolean {
  if (!dialog) return false;
  const roots = document.querySelectorAll(`[${ROOT_ATTRIBUTE}]`);
  return roots.length === 0 || dialog.closest(`[${ROOT_ATTRIBUTE}]`) === roots[roots.length - 1];
}

const SCREEN_ROOT =
  'sam-void fixed inset-0 z-dialog-backdrop flex flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),0.375rem)] pl-[max(env(safe-area-inset-left),0.375rem)] pr-[max(env(safe-area-inset-right),0.375rem)] pt-[max(env(safe-area-inset-top),0.375rem)] md:p-2.5';

const DIALOG_LAYOUT =
  'relative z-dialog flex min-h-0 flex-1 flex-col gap-1.5 outline-none md:gap-2.5';

export interface PreviewFrameProps extends Omit<HTMLAttributes<HTMLDivElement>, 'className'> {
  presentation: PreviewPresentation;
  dialogRef: Ref<HTMLDivElement>;
  /** Closes the preview from a click on the scrim (overlay only). */
  onClose: () => void;
  /** Rendered inside the portal but outside the dialog (selection popovers). */
  outside?: ReactNode;
  children: ReactNode;
}

export function PreviewFrame({
  presentation,
  dialogRef,
  onClose,
  outside,
  children,
  ...dialogProps
}: PreviewFrameProps) {
  const isMobile = useIsMobile();
  const framed = presentation === 'overlay' && !isMobile;

  const dialog = (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      {...dialogProps}
      className={
        framed
          ? `${paneClassName('overlay')} ${DIALOG_LAYOUT} h-full w-full max-w-6xl p-2.5`
          : DIALOG_LAYOUT
      }
    >
      {children}
    </div>
  );

  // One wrapper for both presentations, so crossing the breakpoint restyles the viewer instead
  // of remounting it (an open comments panel or a half-written comment survives a resize).
  return createPortal(
    <div
      className={
        framed
          ? 'fixed inset-0 z-dialog-backdrop flex items-stretch justify-center p-6 lg:p-10'
          : SCREEN_ROOT
      }
      data-presentation={framed ? 'overlay' : 'screen'}
      data-testid="library-preview-root"
      data-library-preview-root=""
    >
      {/* The scrim is a mouse convenience; keyboard and screen-reader users close with the
          header's close button or Escape, so it is hidden from them. */}
      {framed && (
        <div className="sam-scrim absolute inset-0" aria-hidden="true" onClick={onClose} />
      )}
      {dialog}
      {outside}
    </div>,
    document.body
  );
}
