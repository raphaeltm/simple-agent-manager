import type { HTMLAttributes } from 'react';

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string | null | undefined;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'human' | 'agent' | 'neutral';
}

const sizeClasses = {
  sm: 'h-5 w-5 text-[0.625rem]',
  md: 'h-6 w-6 text-xs',
  lg: 'h-8 w-8 text-sm',
} satisfies Record<NonNullable<AvatarProps['size']>, string>;

const toneClasses = {
  human:
    'border-[var(--sam-color-success-fg)] bg-[var(--sam-color-accent-primary-tint)] text-[var(--sam-color-success-fg)]',
  agent:
    'border-[var(--sam-color-tn-blue)] bg-[var(--sam-color-info-tint)] text-[var(--sam-color-tn-blue)]',
  neutral: 'border-border-default bg-surface text-fg-muted',
} satisfies Record<NonNullable<AvatarProps['tone']>, string>;

function initialsForName(name: string | null | undefined): string {
  const cleaned = name?.trim();
  if (!cleaned) return '?';
  const parts = cleaned.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const second = parts.length > 1 ? (parts[1]?.[0] ?? '') : (parts[0]?.[1] ?? '');
  return `${first}${second}`.toUpperCase();
}

export function Avatar({
  name,
  imageUrl,
  size = 'md',
  tone = 'neutral',
  className = '',
  ...props
}: AvatarProps) {
  const label = name?.trim() || 'Unknown author';

  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border font-semibold select-none ${sizeClasses[size]} ${toneClasses[tone]} ${className}`}
      {...props}
    >
      {imageUrl ? (
        <img src={imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        initialsForName(name)
      )}
    </span>
  );
}
