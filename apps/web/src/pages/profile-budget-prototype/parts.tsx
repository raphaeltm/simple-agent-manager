import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { Chip, DropdownMenu } from '@simple-agent-manager/ui';
import { Copy, Pencil, Trash2, Zap } from 'lucide-react';

import { ProviderMark } from '../../components/accounts/AccountBits';
import { getAccountProvider } from '../../components/accounts/provider-meta';
import { type AccountBudget, type EffectiveWindow, levelColor, READINESS } from './budget';
import type { MockProfile } from './mock-data';
import { UNSAMPLED_ACCOUNTS } from './mock-data';

export function AgentMark({ agentType, size = 28 }: Readonly<{ agentType: string; size?: number }>) {
  return <ProviderMark provider={getAccountProvider('agent', agentType)} size={size} />;
}

const EFFORT: Record<string, string> = {
  low: 'Low effort',
  medium: 'Medium effort',
  high: 'High effort',
  xhigh: 'Extra-high effort',
  max: 'Max effort',
};

/** Model first (it is the thing you pick by), then the knobs as quiet words. */
export function ProfileFacts({ profile }: Readonly<{ profile: MockProfile }>) {
  const facts = [
    profile.effort ? EFFORT[profile.effort] : null,
    profile.taskMode === 'task' ? 'Task' : 'Chat',
    profile.runtime === 'instant' ? 'Instant' : profile.vmSize ? `VM ${profile.vmSize}` : 'VM',
    profile.permissionMode === 'bypassPermissions' ? 'No approvals' : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
      <span className="min-w-0 max-w-full truncate rounded-sm bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg-primary">
        {profile.model}
      </span>
      {facts.map((fact) => (
        <span key={fact} className="whitespace-nowrap">
          {fact === 'Instant' && <Zap size={11} aria-hidden="true" className="mr-0.5 inline" />}
          {fact}
        </span>
      ))}
    </div>
  );
}

export function ReadinessChip({ budget }: Readonly<{ budget: AccountBudget }>) {
  const meta = READINESS[budget.readiness];
  return (
    <Chip tone={meta.tone} size="sm" dot>
      {meta.label}
    </Chip>
  );
}

export function UsageRow({
  window,
  stacked = false,
}: Readonly<{ window: EffectiveWindow; stacked?: boolean }>) {
  const color = levelColor(window.level);
  const pct = window.percent ?? 0;
  return (
    <div
      className={`grid min-w-0 items-center gap-x-2.5 ${stacked ? 'grid-cols-[4.75rem_1fr_2.75rem]' : 'grid-cols-[4.75rem_1fr_2.75rem] sm:grid-cols-[5rem_1fr_2.75rem_8.5rem]'}`}
    >
      <span className="truncate text-xs text-fg-muted">{window.label}</span>
      <div
        className="h-1.5 min-w-0 overflow-hidden rounded-full bg-[var(--sam-glass-v2-well-shade)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label={`${window.label} used`}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }}
        />
      </div>
      <span className="text-right text-xs font-semibold tabular-nums" style={{ color }}>
        {window.percent === null ? '—' : `${Math.round(window.percent)}%`}
      </span>
      <span
          className={`col-span-3 -mt-0.5 text-[11px] ${stacked ? '' : 'sm:col-span-1 sm:mt-0 sm:text-right'} ${window.resetElapsed ? 'text-info-fg' : 'text-fg-muted'}`}
        >
          {window.resetElapsed && <span aria-hidden="true">↻ </span>}
          {window.resetText ?? 'reset unknown'}
        </span>
    </div>
  );
}

export function accountName(ref: string, account: CredentialLimitCredentialSummary | null): string {
  return account?.credentialName ?? UNSAMPLED_ACCOUNTS[ref]?.name ?? 'Unknown account';
}

export function ProfileMenu({ name }: Readonly<{ name: string }>) {
  return (
    <DropdownMenu
      aria-label={`Actions for ${name}`}
      items={[
        { id: 'edit', label: 'Edit', icon: <Pencil size={14} />, onClick: () => undefined },
        { id: 'dup', label: 'Duplicate', icon: <Copy size={14} />, onClick: () => undefined },
        {
          id: 'delete',
          label: 'Delete',
          icon: <Trash2 size={14} />,
          variant: 'danger',
          onClick: () => undefined,
        },
      ]}
    />
  );
}
