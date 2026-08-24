import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useEscapeKey } from '../hooks/useEscapeKey';

export interface PopoverAnchorPoint {
  x: number;
  y: number;
}

export interface PopoverProps {
  open: boolean;
  anchorPoint: PopoverAnchorPoint | null;
  children: ReactNode;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'bottom';
  align?: 'start' | 'center' | 'end';
  role?: 'dialog' | 'menu';
  'aria-label'?: string;
  className?: string;
  /**
   * Stacking layer utility class. Defaults to the dropdown layer, which sits
   * BELOW dialogs — a popover opened from inside a modal must raise this or the
   * modal's own content will intercept its clicks.
   */
  layerClassName?: string;
}

const POPOVER_GUTTER = 8;

function getPopoverStyle(
  anchorPoint: PopoverAnchorPoint,
  popover: DOMRect,
  side: NonNullable<PopoverProps['side']>,
  align: NonNullable<PopoverProps['align']>
): CSSProperties {
  const alignedLeft =
    align === 'start'
      ? anchorPoint.x
      : align === 'end'
        ? anchorPoint.x - popover.width
        : anchorPoint.x - popover.width / 2;
  const preferredTop =
    side === 'top' ? anchorPoint.y - popover.height - POPOVER_GUTTER : anchorPoint.y + POPOVER_GUTTER;

  return {
    left: Math.max(POPOVER_GUTTER, Math.min(alignedLeft, window.innerWidth - popover.width - POPOVER_GUTTER)),
    top: Math.max(POPOVER_GUTTER, Math.min(preferredTop, window.innerHeight - popover.height - POPOVER_GUTTER)),
  };
}

export function Popover({
  open,
  anchorPoint,
  children,
  onOpenChange,
  side = 'top',
  align = 'center',
  role = 'dialog',
  'aria-label': ariaLabel,
  className = '',
  layerClassName = 'z-dropdown',
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useEscapeKey(() => onOpenChange?.(false), open);

  useLayoutEffect(() => {
    if (!open || !anchorPoint || !popoverRef.current) return;

    const updatePosition = () => {
      const rect = popoverRef.current?.getBoundingClientRect();
      if (!rect) return;
      setStyle(getPopoverStyle(anchorPoint, rect, side, align));
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, anchorPoint, open, side]);

  if (!open || !anchorPoint || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={popoverRef}
      role={role}
      aria-label={ariaLabel}
      className={`fixed ${layerClassName} rounded-md border border-border-default bg-surface text-fg-primary shadow-lg ${className}`}
      style={style}
    >
      {children}
    </div>,
    document.body
  );
}
