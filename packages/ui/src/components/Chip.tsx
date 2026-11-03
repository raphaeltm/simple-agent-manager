import type { HTMLAttributes, ReactNode } from 'react';

/** Status and metadata chips: solid tints in mono text, never glass. */
export type ChipTone = 'neutral' | 'success' | 'info' | 'warning' | 'danger' | 'muted';

const toneClasses: Record<ChipTone, string> = {
  neutral: 'text-fg-primary bg-[var(--sam-chip-bg)] border-[var(--sam-chip-edge)]',
  success:
    'text-[var(--sam-status-success-fg)] bg-[var(--sam-status-success-bg)] border-[var(--sam-success-edge)]',
  info: 'text-[var(--sam-status-info-fg)] bg-[var(--sam-status-info-bg)] border-[var(--sam-info-edge)]',
  warning:
    'text-[var(--sam-status-warning-fg)] bg-[var(--sam-status-warning-bg)] border-[var(--sam-warning-edge)]',
  danger:
    'text-[var(--sam-status-danger-fg)] bg-[var(--sam-status-danger-bg)] border-[var(--sam-danger-edge)]',
  muted: 'text-[var(--sam-status-muted-fg)] bg-[var(--sam-status-muted-bg)] border-[var(--sam-chip-edge)]',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  size?: 'sm' | 'md';
  /** A glowing status dot in the chip's colour. */
  dot?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

/** The classes a Chip renders with, for links and buttons that must look like one. */
export function chipClassName({ tone = 'neutral', size = 'md' }: { tone?: ChipTone; size?: 'sm' | 'md' } = {}) {
  const sizeClass = size === 'md' ? 'h-7 gap-[7px] px-[11px] text-xs' : 'h-6 gap-1.5 px-[9px] text-[11.5px]';
  return `inline-flex max-w-full shrink-0 items-center whitespace-nowrap rounded-full border font-mono no-underline ${sizeClass} ${toneClasses[tone]}`;
}

export function ChipDot() {
  return (
    <span
      aria-hidden="true"
      className="h-[7px] w-[7px] shrink-0 rounded-full bg-current shadow-[0_0_8px_currentColor]"
    />
  );
}

export function Chip({ tone = 'neutral', size = 'md', dot = false, icon, className = '', children, ...props }: ChipProps) {
  return (
    <span {...props} className={`${chipClassName({ tone, size })} ${className}`}>
      {dot && <ChipDot />}
      {icon}
      {children}
    </span>
  );
}
