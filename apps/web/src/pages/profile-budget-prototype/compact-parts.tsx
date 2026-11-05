/**
 * Low-key usage and resource pieces for the iterated profile list. Usage is a
 * strip of micro-meters that opens the full breakdown on tap; resources are one
 * muted line.
 */
import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { Dialog } from '@simple-agent-manager/ui';
import { Cpu, Lock, Zap } from 'lucide-react';
import { useId, useState } from 'react';

import { type AccountBudget, type EffectiveWindow, levelColor, READINESS } from './budget';
import type { MockProfile } from './mock-data';
import { accountName, AgentMark, UsageRow } from './parts';
import {
  resolveResources,
  RESOURCE_SOURCE_LABEL,
  resourceLong,
  resourceShort,
} from './resources';

const VIA_LABEL = {
  'profile pin': 'pinned to this profile',
  'project pin': 'project account',
  default: 'your default account',
  platform: 'SAM platform',
} as const;

/** Short window labels for the strip: "Opus week" → "Opus", "Week" → "Wk". */
function stripLabel(label: string): string {
  if (label === 'Week') return 'Wk';
  if (label === 'Month') return 'Mo';
  if (label === 'Rolling') return 'Roll';
  return label.replace(/ week$/, '');
}

function MicroMeter({ window }: Readonly<{ window: EffectiveWindow }>) {
  const color = levelColor(window.level);
  const pct = Math.min(100, Math.max(0, window.percent ?? 0));
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-fg-muted">{stripLabel(window.label)}</span>
      <span
        aria-hidden="true"
        className="relative inline-block h-[3px] w-5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--sam-color-fg-muted)_28%,transparent)]"
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
      <span
        className="tabular-nums"
        style={{ color: window.level === 'ok' ? undefined : color }}
      >
        {window.percent === null ? '—' : `${Math.round(window.percent)}%`}
      </span>
      {window.resetElapsed && (
        <span className="text-info-fg" title={window.resetText ?? undefined}>
          ↻
        </span>
      )}
    </span>
  );
}

export function UsageDialog({
  open,
  onClose,
  profile,
  account,
  budget,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  profile: MockProfile;
  account: CredentialLimitCredentialSummary | null;
  budget: AccountBudget;
}>) {
  const headingId = useId();
  const name = accountName(profile.accountRef, account);
  return (
    <Dialog isOpen={open} onClose={onClose} aria-labelledby={headingId} maxWidth="md">
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <AgentMark agentType={profile.agentType} size={32} />
          <div className="min-w-0">
            <h2 id={headingId} className="m-0 text-base font-semibold text-fg-primary">
              {name}
            </h2>
            <p className="m-0 mt-0.5 text-xs text-fg-muted">
              {VIA_LABEL[profile.accountVia]} · {READINESS[budget.readiness].label}
            </p>
          </div>
        </div>
        {budget.windows.length > 0 ? (
          <div className="flex flex-col gap-2.5 rounded-[var(--sam-radius-control)] sam-well px-3 py-3">
            {budget.windows.map((w) => (
              <UsageRow key={w.raw.windowType} window={w} stacked />
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-fg-muted">This account bills per token.</p>
        )}
        <p className="m-0 text-[11px] leading-relaxed text-fg-muted">
          Latest samples SAM saw while an agent ran on this account. A window whose reset time
          has passed reads 0% until the next sample.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * The usage strip: "◔ 5h ▂ 72% · Wk ▁ 31% · Opus ▆ 88%". One tap opens the
 * breakdown. Colour only appears on windows that need attention.
 */
export function UsageStrip({
  profile,
  account,
  budget,
}: Readonly<{
  profile: MockProfile;
  account: CredentialLimitCredentialSummary | null;
  budget: AccountBudget;
}>) {
  const [open, setOpen] = useState(false);
  const name = accountName(profile.accountRef, account);
  const dot = READINESS[budget.readiness].color;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Usage for ${name}: ${READINESS[budget.readiness].label}. Open details`}
        className={`-mx-1 inline-flex min-w-0 max-w-full cursor-pointer ${budget.windows.length > 0 ? 'flex-wrap' : 'flex-nowrap'} items-center gap-x-2.5 gap-y-1 rounded-sm border-0 bg-transparent px-1 py-0.5 text-[11px] text-fg-primary hover:bg-[var(--sam-glass-v2-well-shade)] focus-visible:outline-2 focus-visible:outline-focus-ring`}
        data-testid="usage-strip"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
        />
        {budget.windows.length > 0 ? (
          budget.windows.map((w) => <MicroMeter key={w.raw.windowType} window={w} />)
        ) : (
          <span className="whitespace-nowrap text-fg-muted">per-token</span>
        )}
      </button>
      <UsageDialog
        open={open}
        onClose={() => setOpen(false)}
        profile={profile}
        account={account}
        budget={budget}
      />
    </>
  );
}

/** "⚙ 2 vCPU · 3.6 GB" muted, or "⚡ Instant". Inherited values read quieter still. */
export function ResourceLine({ profile }: Readonly<{ profile: MockProfile }>) {
  const r = resolveResources(profile);
  if (!r) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-fg-muted">
        <Zap size={11} aria-hidden="true" />
        Instant container
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] text-fg-muted"
      title={`${resourceLong(r)} — ${RESOURCE_SOURCE_LABEL[r.source]}`}
    >
      <Cpu size={11} aria-hidden="true" className="shrink-0" />
      <span
        className={`whitespace-nowrap tabular-nums ${r.source === 'default' ? 'opacity-70' : 'text-fg-primary'}`}
      >
        {resourceShort(r)}
      </span>
      {r.source === 'default' && <span className="whitespace-nowrap opacity-70">(default)</span>}
      {r.exclusive && (
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-warning-fg">
          <Lock size={10} aria-hidden="true" />
          own node
        </span>
      )}
    </span>
  );
}

/** A single ring for the binding window: how much is left on whatever stops you first. */
export function HeadroomRing({
  profile,
  account,
  budget,
}: Readonly<{
  profile: MockProfile;
  account: CredentialLimitCredentialSummary | null;
  budget: AccountBudget;
}>) {
  const [open, setOpen] = useState(false);
  const meta = READINESS[budget.readiness];
  const used = budget.binding?.percent ?? 0;
  const r = 8;
  const c = 2 * Math.PI * r;
  const known = budget.headroom !== null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${meta.label}. Open usage details`}
        className="flex shrink-0 cursor-pointer flex-col items-end gap-0 rounded-sm border-0 bg-transparent px-1 py-0.5 text-right hover:bg-[var(--sam-glass-v2-well-shade)] focus-visible:outline-2 focus-visible:outline-focus-ring"
      >
        <span className="inline-flex items-center gap-1.5">
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r={r} fill="none" stroke="color-mix(in srgb, var(--sam-color-fg-muted) 28%, transparent)" strokeWidth="3" />
            {known && (
              <circle
                cx="10"
                cy="10"
                r={r}
                fill="none"
                stroke={meta.color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={`${(c * Math.max(0, 100 - used)) / 100} ${c}`}
                transform="rotate(-90 10 10)"
              />
            )}
          </svg>
          <span className="text-xs font-semibold tabular-nums" style={{ color: meta.color }}>
            {known ? `${budget.headroom}% left` : '—'}
          </span>
        </span>
        <span className="text-[10px] text-fg-muted">
          {known
            ? `${stripLabel(budget.binding?.label ?? '')} · ${budget.binding?.resetElapsed ? '↻ reset' : (budget.binding?.resetText?.replace('resets in ', '') ?? '')}`
            : 'per-token'}
        </span>
      </button>
      <UsageDialog
        open={open}
        onClose={() => setOpen(false)}
        profile={profile}
        account={account}
        budget={budget}
      />
    </>
  );
}
