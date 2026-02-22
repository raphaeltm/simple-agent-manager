import { useState, useRef, useId, type ReactElement, type CSSProperties } from 'react';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface TooltipProps {
  content: string;
  children: ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
}

const tooltipBaseStyle: CSSProperties = {
  position: 'absolute',
  padding: 'var(--sam-space-1) var(--sam-space-2)',
  background: 'var(--sam-color-bg-surface)',
  border: '1px solid var(--sam-color-border-default)',
  borderRadius: 'var(--sam-radius-sm)',
  boxShadow: 'var(--sam-shadow-tooltip)',
  color: 'var(--sam-color-fg-primary)',
  fontSize: 'var(--sam-type-caption-size)',
  lineHeight: 'var(--sam-type-caption-line-height)',
  maxWidth: 200,
  zIndex: 'var(--sam-z-dropdown)',
  pointerEvents: 'none',
  whiteSpace: 'normal',
};

function getPositionStyle(side: 'top' | 'bottom' | 'left' | 'right'): CSSProperties {
  switch (side) {
    case 'top':
      return { bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 'var(--sam-space-1)' };
    case 'bottom':
      return { top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 'var(--sam-space-1)' };
    case 'left':
      return { right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 'var(--sam-space-1)' };
    case 'right':
      return { left: '100%', top: '50%', transform: 'translateY(-50%)', marginLeft: 'var(--sam-space-1)' };
  }
}

export function Tooltip({ content, children, side = 'top', delay = 400 }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipId = useId();

  useEscapeKey(() => setIsVisible(false), isVisible);

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
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={showAfterDelay}
      onMouseLeave={hide}
      onFocus={showImmediate}
      onBlur={hide}
    >
      <span aria-describedby={isVisible ? tooltipId : undefined}>
        {children}
      </span>

      {isVisible && (
        <span
          id={tooltipId}
          role="tooltip"
          style={{ ...tooltipBaseStyle, ...getPositionStyle(side) }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
