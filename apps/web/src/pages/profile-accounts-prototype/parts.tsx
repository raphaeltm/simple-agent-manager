import { AlertTriangle, ArrowDown, Ban, CheckCircle2, Circle, CircleSlash, Lock, ShieldCheck, Users } from 'lucide-react';
import type { ReactNode } from 'react';

import { type Account, AGENT_LABEL, AGENT_MARK, type AgentType } from './mock-data';
import type { Outcome, Resolution, StepState } from './resolve';

export function AgentMark({ agentType, size = 28 }: Readonly<{ agentType: AgentType; size?: number }>) {
  const mark = AGENT_MARK[agentType];
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-md font-bold"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.36),
        color: mark.hue,
        background: `color-mix(in srgb, ${mark.hue} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${mark.hue} 40%, transparent)`,
      }}
    >
      {mark.glyph}
    </span>
  );
}

export function Panel({ title, aside, children }: Readonly<{ title?: ReactNode; aside?: ReactNode; children: ReactNode }>) {
  return (
    <section className="min-w-0 rounded-lg border border-border-default bg-surface p-3 sm:p-4">
      {(title || aside) && (
        <header className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
          {title && <h3 className="m-0 min-w-0 text-sm font-semibold text-fg-primary">{title}</h3>}
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tag({ tone = 'muted', icon, children }: Readonly<{ tone?: 'muted' | 'info' | 'accent' | 'warning' | 'danger'; icon?: ReactNode; children: ReactNode }>) {
  const tones = {
    muted: 'border-border-default text-fg-muted',
    info: 'border-[color-mix(in_srgb,var(--sam-color-info)_40%,transparent)] bg-info-tint text-info-fg',
    accent: 'border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)] bg-accent-tint text-success-fg',
    warning: 'border-[color-mix(in_srgb,var(--sam-color-warning)_40%,transparent)] bg-warning-tint text-warning-fg',
    danger: 'border-[color-mix(in_srgb,var(--sam-color-danger)_40%,transparent)] bg-danger-tint text-danger-fg',
  };
  return (
    <span className={`inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

export const PrivateTag = () => (
  <Tag icon={<Lock size={10} aria-hidden="true" />}>Only you see this</Tag>
);
export const TeamTag = () => (
  <Tag tone="info" icon={<Users size={10} aria-hidden="true" />}>Shared with the team</Tag>
);

const STEP_ICON: Record<StepState, ReactNode> = {
  wins: <CheckCircle2 size={16} className="text-success-fg" aria-hidden="true" />,
  skipped: <CircleSlash size={16} className="text-fg-muted" aria-hidden="true" />,
  empty: <Circle size={16} className="text-fg-muted" aria-hidden="true" />,
  halts: <Ban size={16} className="text-danger-fg" aria-hidden="true" />,
  'not-reached': <Circle size={16} className="text-fg-muted opacity-40" aria-hidden="true" />,
};

const STEP_WORD: Record<StepState, string> = {
  wins: 'Used',
  skipped: 'Skipped',
  empty: 'Not set',
  halts: 'Stops here',
  'not-reached': 'Not checked',
};

/** The resolution ladder: every layer, top to bottom, and which one answered. */
export function Ladder({ resolution }: Readonly<{ resolution: Resolution }>) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="How SAM picks the account">
      {resolution.steps.map((step, i) => (
        <li
          key={step.tier}
          className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 ${
            step.state === 'wins'
              ? 'bg-accent-tint'
              : step.state === 'halts'
                ? 'bg-danger-tint'
                : step.state === 'not-reached'
                  ? 'opacity-50'
                  : ''
          }`}
        >
          <span className="mt-0.5 w-4 shrink-0 text-center text-[11px] font-semibold text-fg-muted">{i + 1}</span>
          <span className="mt-0.5">{STEP_ICON[step.state]}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-[13px] font-medium text-fg-primary">{step.title}</span>
              <span className="text-[11px] uppercase tracking-wide text-fg-muted">{STEP_WORD[step.state]}</span>
            </span>
            <span className="block break-words text-xs text-fg-muted">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function OutcomeLine({ outcome, agentType }: Readonly<{ outcome: Outcome; agentType: AgentType }>) {
  if (outcome.kind === 'account') {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)] bg-accent-tint p-2.5">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success-fg" aria-hidden="true" />
        <p className="m-0 min-w-0 break-words text-[13px] text-fg-primary">
          Runs {AGENT_LABEL[agentType]} on <strong>{outcome.label}</strong>
          {outcome.viaProxy && (
            <span className="text-fg-muted"> — the key stays on SAM; the agent calls through SAM’s proxy</span>
          )}
        </p>
      </div>
    );
  }
  if (outcome.kind === 'halt') {
    return (
      <div className="flex min-w-0 items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--sam-color-danger)_40%,transparent)] bg-danger-tint p-2.5">
        <Ban size={16} className="mt-0.5 shrink-0 text-danger-fg" aria-hidden="true" />
        <p className="m-0 min-w-0 break-words text-[13px] text-fg-primary">{outcome.reason}</p>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--sam-color-warning)_40%,transparent)] bg-warning-tint p-2.5">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden="true" />
      <p className="m-0 min-w-0 text-[13px] text-fg-primary">
        No {AGENT_LABEL[agentType]} account. SAM refuses the run before creating a workspace.
      </p>
    </div>
  );
}

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}

/** Radio list for "which account". The first option is always the inherit option. */
export function AccountPicker({ name, options, value, onChange, disabled }: Readonly<{
  name: string;
  options: PickerOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}>) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" disabled={disabled}>
      {options.map((option) => (
        <label
          key={option.value}
          className={`flex min-h-11 min-w-0 cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 ${
            value === option.value ? 'border-accent bg-accent-tint' : 'border-border-default bg-inset'
          } ${option.disabled || disabled ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <input
            type="radio"
            name={name}
            className="mt-1 shrink-0 accent-[var(--sam-color-accent-primary)]"
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-fg-primary" title={option.label}>{option.label}</span>
            {(option.hint || option.disabledReason) && (
              <span className="block break-words text-xs text-fg-muted">{option.disabledReason ?? option.hint}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function accountOptions(accounts: Account[], agentType: AgentType): PickerOption[] {
  return accounts
    .filter((a) => a.agentType === agentType)
    .map((a) => ({
      value: a.id,
      label: a.label,
      hint: a.active ? undefined : 'Paused — turn it back on in Settings → Agents',
      disabled: !a.active,
    }));
}

export function Toggle({ checked, onChange, label, hint, disabled }: Readonly<{
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}>) {
  return (
    <label className={`flex min-h-11 min-w-0 items-start gap-2.5 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox"
        className="mt-1 shrink-0 accent-[var(--sam-color-accent-primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[13px] text-fg-primary">{label}</span>
        {hint && <span className="block text-xs text-fg-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function Callout({ icon = 'shield', children }: Readonly<{ icon?: 'shield' | 'down'; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md border border-dashed border-border-default p-2.5 text-xs text-fg-muted">
      {icon === 'shield' ? (
        <ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      ) : (
        <ArrowDown size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
