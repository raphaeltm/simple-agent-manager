/**
 * Small visual pieces shared by every account surface: the provider mark, the
 * role badge and the status line. Roles are never colour-only — each badge
 * carries an icon and a word.
 */
import { AlertTriangle, CircleCheck, CircleDashed, CirclePause, Pin, Star } from 'lucide-react';
import type { ReactNode } from 'react';

import type { AccountRole, AccountView } from './account-model';
import type { AccountProvider } from './provider-meta';

export function ProviderMark({
  provider,
  size = 32,
}: Readonly<{ provider: Pick<AccountProvider, 'glyph' | 'hue'>; size?: number }>) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold tracking-tight"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        color: provider.hue,
        background: `color-mix(in srgb, ${provider.hue} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${provider.hue} 40%, transparent)`,
      }}
    >
      {provider.glyph}
    </span>
  );
}

const ROLE_BADGES: Record<
  AccountRole,
  { label: string; className: string; Icon: typeof Star; filled?: boolean }
> = {
  default: {
    label: 'Default',
    className:
      'border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)] bg-accent-tint text-success-fg',
    Icon: Star,
    filled: true,
  },
  pinned: {
    label: 'Pinned',
    className:
      'border-[color-mix(in_srgb,var(--sam-color-info)_40%,transparent)] bg-info-tint text-info-fg',
    Icon: Pin,
  },
  unattached: {
    label: 'Unattached',
    className: 'border-dashed border-border-default bg-transparent text-fg-muted',
    Icon: CircleDashed,
  },
};

export function RoleBadge({ role }: Readonly<{ role: AccountRole }>) {
  const badge = ROLE_BADGES[role];
  const Icon = badge.Icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${badge.className}`}
    >
      <Icon size={11} aria-hidden="true" fill={badge.filled ? 'currentColor' : 'none'} />
      {badge.label}
    </span>
  );
}

/** One line answering "is this account working?" from what SAM actually knows. */
export function AccountStatus({ account }: Readonly<{ account: AccountView }>) {
  if (!account.active) {
    return (
      <StatusLine tone="text-warning-fg" Icon={CirclePause}>
        Paused — turned off in Advanced
      </StatusLine>
    );
  }
  if (account.pausedProjectIds.length > 0) {
    const count = account.pausedProjectIds.length;
    return (
      <StatusLine tone="text-warning-fg" Icon={CirclePause}>
        Paused for {count} project{count === 1 ? '' : 's'} — {count === 1 ? 'it' : 'they'} can’t
        use this account until it’s resumed or removed
      </StatusLine>
    );
  }
  const validation = account.validation;
  if (validation?.status === 'invalid') {
    return (
      <StatusLine tone="text-danger-fg" Icon={AlertTriangle}>
        {validation.message ?? 'Credential looks invalid'}
      </StatusLine>
    );
  }
  if (validation?.status === 'warning') {
    return (
      <StatusLine tone="text-warning-fg" Icon={AlertTriangle}>
        {validation.warnings?.join(' ') ?? validation.message ?? 'Needs attention'}
      </StatusLine>
    );
  }
  // An unattached account's footer already says nothing uses it.
  if (account.role === 'unattached') return null;
  return (
    <StatusLine tone="text-success-fg" Icon={CircleCheck}>
      Active
    </StatusLine>
  );
}

function StatusLine({
  tone,
  Icon,
  children,
}: Readonly<{ tone: string; Icon: typeof Star; children: ReactNode }>) {
  return (
    <span className={`inline-flex min-w-0 items-start gap-1 text-xs ${tone}`}>
      <Icon size={13} aria-hidden="true" className="mt-px shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
