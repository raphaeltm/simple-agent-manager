import type { MouseEventHandler, ReactNode } from 'react';
import { Link } from 'react-router';

import { Count, type CountTone } from './Count';

export interface NavItemProps {
  label: string;
  icon: ReactNode;
  /** Router path. Without one the item renders as a button. */
  to?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  current?: boolean;
  count?: number;
  countTone?: CountTone;
  /** Focus Mode rail: icon only, label in the accessible name and tooltip. */
  iconOnly?: boolean;
  /** `lg` (44px rows, 16px text) for touch drawers. */
  size?: 'md' | 'lg';
  className?: string;
}

const BASE =
  'group/nav flex w-full items-center gap-3 rounded-[11px] border-0 text-left no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
const CURRENT =
  'font-medium text-fg-primary bg-[linear-gradient(180deg,var(--sam-nav-active-top),var(--sam-nav-active-bottom))] shadow-[inset_0_1px_0_var(--sam-glass-v2-raised-edge),inset_0_-1px_0_var(--sam-glass-v2-rim-bottom),var(--sam-shadow-glow-active)]';
const RESTING =
  'bg-transparent text-[var(--sam-nav-fg)] hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary';

/** The classes a NavItem renders with. */
export function navItemClassName({
  current = false,
  iconOnly = false,
  size = 'md',
}: { current?: boolean; iconOnly?: boolean; size?: 'md' | 'lg' } = {}): string {
  const sizeClass = iconOnly
    ? 'h-10 justify-center px-0'
    : size === 'lg'
      ? 'min-h-11 px-3 text-base'
      : 'h-10 px-3 text-[14.5px]';
  return `${BASE} ${sizeClass} ${current ? CURRENT : RESTING}`;
}

/** A sidebar row: icon, label, optional count. The current item is raised and lit. */
export function NavItem({
  label,
  icon,
  to,
  onClick,
  current = false,
  count,
  countTone = 'active',
  iconOnly = false,
  size = 'md',
  className = '',
}: NavItemProps) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className={`inline-flex shrink-0 ${current ? 'text-[var(--sam-status-success-fg)]' : 'text-fg-muted group-hover/nav:text-fg-primary'}`}
      >
        {icon}
      </span>
      {!iconOnly && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {count !== undefined && count > 0 && (
        <Count value={count} tone={countTone} floating={iconOnly} className={iconOnly ? '' : 'ml-auto'} />
      )}
    </>
  );
  const ariaLabel =
    count !== undefined && count > 0 ? `${label}, ${count}` : iconOnly ? label : undefined;
  const classes = `${navItemClassName({ current, iconOnly, size })} ${iconOnly ? 'relative' : ''} ${className}`;
  if (to) {
    return (
      <Link
        to={to}
        onClick={onClick}
        aria-current={current ? 'page' : undefined}
        aria-label={ariaLabel}
        title={iconOnly ? label : undefined}
        className={classes}
      >
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      aria-label={ariaLabel}
      title={iconOnly ? label : undefined}
      className={`${classes} cursor-pointer`}
    >
      {content}
    </button>
  );
}

/** A mono uppercase label above a group of nav items. */
export function NavLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`truncate px-3 pt-3 pb-1 font-mono text-[11px] uppercase tracking-[0.12em] text-fg-muted ${className}`}
    >
      {children}
    </div>
  );
}
