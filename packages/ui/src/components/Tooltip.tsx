import { type CSSProperties,type ReactElement, useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useEscapeKey } from '../hooks/useEscapeKey';

export interface TooltipProps {
  content: string;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const TOOLTIP_GUTTER = 8;

function getPositionStyle(
  side: 'top' | 'bottom' | 'left' | 'right',
  trigger: DOMRect,
  tooltip: DOMRect,
): CSSProperties {
  const maxLeft = window.innerWidth - tooltip.width - TOOLTIP_GUTTER;
  const maxTop = window.innerHeight - tooltip.height - TOOLTIP_GUTTER;
  const clampLeft = (left: number) => Math.max(TOOLTIP_GUTTER, Math.min(left, maxLeft));
  const clampTop = (top: number) => Math.max(TOOLTIP_GUTTER, Math.min(top, maxTop));

  switch (side) {
    case 'top':
      return {
        left: clampLeft(trigger.left + (trigger.width - tooltip.width) / 2),
        top: clampTop(trigger.top - tooltip.height - TOOLTIP_GUTTER),
      };
    case 'bottom':
      return {
        left: clampLeft(trigger.left + (trigger.width - tooltip.width) / 2),
        top: clampTop(trigger.bottom + TOOLTIP_GUTTER),
      };
    case 'left':
      return {
        left: clampLeft(trigger.left - tooltip.width - TOOLTIP_GUTTER),
        top: clampTop(trigger.top + (trigger.height - tooltip.height) / 2),
      };
    case 'right':
      return {
        left: clampLeft(trigger.right + TOOLTIP_GUTTER),
        top: clampTop(trigger.top + (trigger.height - tooltip.height) / 2),
      };
  }
}

export function Tooltip({ content, children, side = 'top', delay = 400 }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<CSSProperties>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();

  useEscapeKey(() => setIsVisible(false), isVisible);

  const updateTooltipPosition = useCallback(() => {
    if (!triggerRef.current || !tooltipRef.current) return;
    setTooltipStyle(getPositionStyle(
      side,
      triggerRef.current.getBoundingClientRect(),
      tooltipRef.current.getBoundingClientRect(),
    ));
  }, [side]);

  useLayoutEffect(() => {
    if (!isVisible) return;
    updateTooltipPosition();
    window.addEventListener('resize', updateTooltipPosition);
    window.addEventListener('scroll', updateTooltipPosition, true);
    return () => {
      window.removeEventListener('resize', updateTooltipPosition);
      window.removeEventListener('scroll', updateTooltipPosition, true);
    };
  }, [isVisible, updateTooltipPosition]);

  function showAfterDelay() {
    timerRef.current = setTimeout(() => setIsVisible(true), delay);
  }

  function showImmediate() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsVisible(true);
  }

  function hide() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setIsVisible(false);
  }

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={showAfterDelay}
      onMouseLeave={hide}
      onFocus={showImmediate}
      onBlur={hide}
    >
      <span ref={triggerRef} aria-describedby={isVisible ? tooltipId : undefined}>
        {children}
      </span>

      {isVisible && typeof document !== 'undefined' && createPortal(
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          className="fixed py-1 px-2 glass-surface bg-[rgba(8,15,12,0.82)] rounded-sm shadow-tooltip text-fg-primary max-w-[200px] z-dropdown pointer-events-none whitespace-normal"
          style={{
            fontSize: 'var(--sam-type-caption-size)',
            lineHeight: 'var(--sam-type-caption-line-height)',
            ...tooltipStyle,
          }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}
