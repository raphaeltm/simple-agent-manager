import type { ElementType, HTMLAttributes, ReactNode } from 'react';

/**
 * SAM Glass surfaces. Guide: docs/guides/sam-glass-design-system.md
 *
 * - `pane`: sidebar, chat list, settings group, tool rail
 * - `quiet`: a pane other panes sit on (the conversation)
 * - `slab`: a pane laid on another pane (page header, message box, mobile app bar)
 * - `overlay`: a drawer, sheet or popover over content; it blurs what it covers
 *
 * In the app every pane is frosted (it blurs the void behind it, on its ::after; see
 * tokens/sam-glass.css). A pane inside another pane does not blur again.
 */
export type PaneVariant = 'pane' | 'quiet' | 'slab' | 'overlay';

const variantClasses: Record<PaneVariant, string> = {
  pane: 'sam-glass sam-glass-rim rounded-[var(--sam-radius-pane)]',
  quiet: 'sam-glass sam-glass--quiet sam-glass-rim rounded-[var(--sam-radius-pane)]',
  slab: 'sam-glass sam-glass--slab sam-glass-rim rounded-[var(--sam-radius-slab)]',
  // The normal pane fill under its own blur: text on a drawer must stay 4.5:1 whatever passes
  // behind it, and a thinner fill let busy content read through in the light theme.
  overlay: 'sam-glass sam-glass-live sam-glass-rim rounded-[var(--sam-radius-pane)]',
};

/**
 * The classes a Pane renders with, for elements that must be one but render elsewhere.
 * `rounded: false` leaves the corners to the caller (a bottom sheet rounds only its top).
 */
export function paneClassName(
  variant: PaneVariant = 'pane',
  { rounded = true }: { rounded?: boolean } = {}
): string {
  const classes = variantClasses[variant];
  return rounded ? classes : classes.replace(/ rounded-\[[^\]]+\]/, '');
}

export interface PaneProps extends HTMLAttributes<HTMLElement> {
  variant?: PaneVariant;
  /** Element to render: `section` by default; `aside`, `header`, `nav`, `div` and so on. */
  as?: ElementType;
  children?: ReactNode;
}

export function Pane({ variant = 'pane', as: Component = 'section', className = '', children, ...props }: PaneProps) {
  return (
    <Component {...props} className={`${variantClasses[variant]} ${className}`}>
      {children}
    </Component>
  );
}

/** A 1px hairline between groups inside a pane. */
export function PaneSeparator({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`h-px shrink-0 bg-[var(--sam-hairline)] ${className}`} />;
}
