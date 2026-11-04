import { IconButton, paneClassName } from '@simple-agent-manager/ui';
import { X } from 'lucide-react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';

/**
 * The SAM Glass overlay for drawers and side panels: a scrim that only dims, and one pane with
 * the screen's single live blur. On phones it runs edge to edge from its side with its inner
 * corners rounded; from `md` up it floats inside the 16px frame like every other pane.
 *
 * The owner keeps its own behaviour (focus trap, Escape, close animation): this component only
 * supplies the surface, so moving a panel onto it cannot change what the panel does.
 */
export function GlassSheet({
  label,
  edge = 'right',
  onBackdropClick,
  closing = false,
  panelRef,
  widthClassName = 'w-[85vw] max-w-[360px] md:w-[min(400px,50vw)] md:max-w-none',
  backdrop = 'always',
  zClassName = 'z-drawer',
  backdropZClassName = 'z-drawer-backdrop',
  animated = true,
  mobile = 'side',
  role = 'dialog',
  modal = true,
  testId,
  backdropTestId,
  className = '',
  style,
  children,
}: {
  label: string;
  edge?: 'left' | 'right';
  onBackdropClick?: () => void;
  /** Plays the slide-out animation while the owner waits to unmount. */
  closing?: boolean;
  panelRef?: Ref<HTMLDivElement>;
  widthClassName?: string;
  /** `desktop` keeps the conversation visible beside a full-screen phone sheet. */
  backdrop?: 'always' | 'desktop' | 'none';
  zClassName?: string;
  backdropZClassName?: string;
  animated?: boolean;
  /** `full` covers the whole phone screen (reading surfaces); `side` slides in from its edge. */
  mobile?: 'side' | 'full';
  role?: 'dialog' | 'complementary';
  modal?: boolean;
  testId?: string;
  backdropTestId?: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const state = closing ? 'closing' : 'open';
  const sideClassName =
    mobile === 'full'
      ? `max-md:inset-x-0 max-md:rounded-none ${edge === 'right' ? 'md:right-4' : 'md:left-4'}`
      : edge === 'right'
        ? 'right-0 rounded-r-none md:right-4 md:rounded-r-[var(--sam-radius-pane)]'
        : 'left-0 rounded-l-none md:left-4 md:rounded-l-[var(--sam-radius-pane)]';
  return createPortal(
    <>
      {backdrop !== 'none' && (
        <div
          role="presentation"
          data-testid={backdropTestId}
          onClick={onBackdropClick}
          data-state={state}
          className={`sam-scrim fixed inset-0 ${backdrop === 'desktop' ? 'hidden md:block' : ''} ${
            animated ? 'sam-glass-drawer-backdrop' : ''
          } ${backdropZClassName}`}
        />
      )}
      <div
        ref={panelRef}
        role={role}
        aria-modal={role === 'dialog' && modal ? true : undefined}
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        data-edge={edge}
        data-state={state}
        data-sam-modal-root=""
        style={style}
        className={`${paneClassName('overlay')} fixed inset-y-0 flex flex-col overflow-hidden outline-none md:inset-y-4 ${sideClassName} ${widthClassName} ${
          animated ? 'sam-glass-drawer-panel' : ''
        } ${zClassName} ${className}`}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

/** A sheet's title row: icon, title, optional actions and the close button. */
export function GlassSheetHeader({
  icon,
  title,
  titleId,
  actions,
  onClose,
  closeLabel = 'Close',
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  titleId?: string;
  actions?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  /** Extra rows under the title (filters, a search well). */
  children?: ReactNode;
}) {
  return (
    <header className="shrink-0 px-4 pt-3 pb-2">
      <div className="flex min-h-11 items-center gap-2.5">
        {icon && (
          <span aria-hidden="true" className="inline-flex shrink-0 text-fg-muted">
            {icon}
          </span>
        )}
        <h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-[17px] font-semibold text-fg-primary">
          {title}
        </h2>
        {actions}
        {onClose && (
          <IconButton
            label={closeLabel}
            icon={<X size={20} strokeWidth={1.75} />}
            onClick={onClose}
            showTooltip={false}
          />
        )}
      </div>
      {children}
    </header>
  );
}
