import type { PolicyInjectMode, ProjectPolicy } from '@simple-agent-manager/shared';
import { formatPolicyDirectiveLine, formatPolicyIndexLine } from '@simple-agent-manager/shared';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { updatePolicy } from '../../lib/api';
import { FOCUS_RING, GLASS_CARD } from './index';

const numberFormat = new Intl.NumberFormat();

/** Applies to agents right now: active and not past its expiry. */
export function policyApplies(policy: ProjectPolicy, now: number): boolean {
  return policy.active && (policy.expiresAt === null || policy.expiresAt > now);
}

/**
 * Characters this policy adds to every agent session's get_instructions payload. Measured with
 * the same renderer the API uses, plus the newline that joins it into the block.
 */
export function policyInjectedChars(policy: ProjectPolicy): number {
  const line =
    policy.injectMode === 'on_demand'
      ? formatPolicyIndexLine(policy)
      : formatPolicyDirectiveLine(policy);
  return line.length + 1;
}

export function PolicyInjectSummary({ policies }: { policies: ProjectPolicy[] }) {
  const now = Date.now();
  const applying = policies.filter((p) => policyApplies(p, now));
  const pinned = applying.filter((p) => p.injectMode !== 'on_demand');
  const onDemand = applying.filter((p) => p.injectMode === 'on_demand');
  const pinnedChars = pinned.reduce((sum, p) => sum + policyInjectedChars(p), 0);
  const onDemandChars = onDemand.reduce((sum, p) => sum + policyInjectedChars(p), 0);
  return (
    <section
      aria-label="Policy size in agent sessions"
      className={`${GLASS_CARD} grid gap-2 p-3 text-sm sm:grid-cols-2`}
    >
      <p className="m-0 min-w-0 break-words text-fg-muted">
        <span className="font-semibold text-fg-primary">
          {numberFormat.format(pinnedChars)} characters
        </span>{' '}
        sent to every agent session from {pinned.length} pinned{' '}
        {pinned.length === 1 ? 'policy' : 'policies'}.
      </p>
      <p className="m-0 min-w-0 break-words text-fg-muted">
        <span className="font-semibold text-fg-primary">{onDemand.length} on demand</span>: listed
        by title ({numberFormat.format(onDemandChars)} characters), sent in full only when they
        match the task.
      </p>
    </section>
  );
}

const MODE_OPTIONS: Array<{ mode: PolicyInjectMode; label: string }> = [
  { mode: 'pinned', label: 'Pinned' },
  { mode: 'on_demand', label: 'On demand' },
];

export function PolicyInjectModeControl({
  policy,
  projectId,
  onRefresh,
}: {
  policy: ProjectPolicy;
  projectId: string;
  onRefresh: () => Promise<void>;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState<PolicyInjectMode | null>(null);
  const chars = numberFormat.format(policyInjectedChars(policy));
  const onDemand = policy.injectMode === 'on_demand';

  const choose = async (mode: PolicyInjectMode) => {
    if (mode === policy.injectMode || saving) return;
    setSaving(mode);
    try {
      await updatePolicy(projectId, policy.id, { injectMode: mode });
      await onRefresh();
      toast.success(mode === 'pinned' ? 'Policy pinned' : 'Policy set to on demand');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to change inject mode');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <div
        role="group"
        aria-label="How agents receive this policy"
        className="inline-flex w-full shrink-0 rounded-lg border border-[var(--sam-form-border)] p-0.5 sm:w-auto"
      >
        {MODE_OPTIONS.map(({ mode, label }) => {
          const selected = policy.injectMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={selected}
              disabled={saving !== null}
              onClick={() => {
                void choose(mode);
              }}
              className={`min-h-11 flex-1 rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-wait sm:flex-none ${FOCUS_RING} ${
                selected
                  ? 'border border-accent/40 bg-accent/15 text-accent'
                  : 'border border-transparent bg-transparent text-fg-muted hover:text-fg-primary'
              }`}
            >
              {saving === mode ? 'Saving...' : label}
            </button>
          );
        })}
      </div>
      <p className="m-0 min-w-0 break-words text-xs leading-relaxed text-fg-muted">
        {onDemand
          ? `Title only in every session (${chars} characters); full text when it matches the task.`
          : `Adds ${chars} characters to every agent session.`}
      </p>
    </div>
  );
}
