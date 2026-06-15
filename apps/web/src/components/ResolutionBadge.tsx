import type { CCResolutionSource } from '@simple-agent-manager/shared';

type BadgeSource = CCResolutionSource | 'halted' | 'unresolved';

const BADGE_CONFIG: Record<BadgeSource, { label: string; className: string }> = {
  'project-attachment': {
    label: 'This project',
    className: 'bg-accent-tint text-accent border-accent',
  },
  'user-attachment': {
    label: 'Your default',
    className: 'bg-[color-mix(in_srgb,var(--sam-color-accent-primary)_10%,transparent)] text-fg-secondary border-border-default',
  },
  platform: {
    label: 'SAM platform',
    className: 'bg-inset text-fg-muted border-border-default',
  },
  'platform-proxy': {
    label: 'SAM proxy',
    className: 'bg-inset text-fg-muted border-border-default',
  },
  halted: {
    label: 'Halted',
    className: 'bg-[color-mix(in_srgb,var(--sam-color-danger)_10%,transparent)] text-danger border-danger',
  },
  unresolved: {
    label: 'Not configured',
    className: 'bg-inset text-fg-muted border-border-default opacity-60',
  },
};

interface ResolutionBadgeProps {
  source: BadgeSource;
}

export function ResolutionBadge({ source }: ResolutionBadgeProps) {
  const config = BADGE_CONFIG[source] ?? BADGE_CONFIG.unresolved;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap ${config.className}`}
    >
      {config.label}
    </span>
  );
}
