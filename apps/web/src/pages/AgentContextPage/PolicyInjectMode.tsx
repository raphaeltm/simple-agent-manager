import type { PolicyInjectMode, ProjectPolicy } from '@simple-agent-manager/shared';
import { formatPolicyDirectiveLine, formatPolicyIndexLine } from '@simple-agent-manager/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '../../hooks/useToast';
import { updatePolicy } from '../../lib/api';
import { FOCUS_RING, GLASS_CARD } from './index';

const numberFormat = new Intl.NumberFormat();

/**
 * Reaches agents right now: active and not past its expiry. Mirrors the read-time predicate
 * in `getActivePolicies` (packages/project-data/src/do/policies.ts, APPLIES_NOW_SQL).
 */
export function policyApplies(policy: ProjectPolicy, now: number): boolean {
  return policy.active && (policy.expiresAt === null || policy.expiresAt > now);
}

/**
 * Characters this policy adds to every agent session's get_instructions payload. Measured with
 * the same renderer the API uses, plus the newline that joins it into the block.
 */
export function policyInjectedChars(policy: ProjectPolicy, mode = policy.injectMode): number {
  const line =
    mode === 'on_demand' ? formatPolicyIndexLine(policy) : formatPolicyDirectiveLine(policy);
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
        {pinned.length === 1 ? 'policy' : 'policies'} (all policies, not just filtered ones).
      </p>
      <p className="m-0 min-w-0 break-words text-fg-muted">
        <span className="font-semibold text-fg-primary">{onDemand.length} on demand</span>, listed
        by title ({numberFormat.format(onDemandChars)} characters) and sent in full only when they
        match the task.
      </p>
    </section>
  );
}

const MODE_OPTIONS: Array<{ mode: PolicyInjectMode; label: string }> = [
  { mode: 'pinned', label: 'Pinned' },
  { mode: 'on_demand', label: 'On demand' },
];

function sizeText(policy: ProjectPolicy, mode: PolicyInjectMode, saving: boolean): string {
  if (saving) return 'Saving...';
  if (!policyApplies(policy, Date.now())) {
    return policy.active
      ? 'Not sent to agents: this policy has expired.'
      : 'Not sent to agents: this policy is inactive.';
  }
  const chars = numberFormat.format(policyInjectedChars(policy, mode));
  return mode === 'on_demand'
    ? `Title only in every session (${chars} characters); full text when it matches the task.`
    : `Adds ${chars} characters to every agent session.`;
}

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
  const [saving, setSaving] = useState(false);
  // The mode the server accepted, shown until the refetched row arrives. Keyed on the row's
  // updatedAt so a refetch (or someone else's change) replaces it, and a refetch that fails
  // cannot leave the control showing the old mode after a success toast.
  const [accepted, setAccepted] = useState<{ mode: PolicyInjectMode; updatedAt: number } | null>(
    null
  );
  const mode =
    accepted && accepted.updatedAt === policy.updatedAt ? accepted.mode : policy.injectMode;

  const choose = async (next: PolicyInjectMode) => {
    if (next === mode || saving) return;
    setSaving(true);
    try {
      await updatePolicy(projectId, policy.id, { injectMode: next });
      setAccepted({ mode: next, updatedAt: policy.updatedAt });
      toast.success(next === 'pinned' ? 'Policy pinned' : 'Policy set to on demand');
      await onRefresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to change inject mode');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
      <div
        role="group"
        aria-label={`How agents receive "${policy.title}"`}
        aria-busy={saving}
        className="inline-flex w-full shrink-0 rounded-lg border border-[var(--sam-form-border)] p-0.5 sm:w-auto"
      >
        {MODE_OPTIONS.map((option) => {
          const selected = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={selected}
              // aria-disabled, not disabled: disabling the button that was just pressed would
              // drop keyboard focus to <body>. `choose` ignores presses while saving.
              aria-disabled={saving}
              onClick={() => {
                void choose(option.mode);
              }}
              className={`inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-xs transition-colors aria-disabled:cursor-wait sm:flex-none ${FOCUS_RING} ${
                selected
                  ? 'sam-raised font-semibold text-fg-primary'
                  : 'bg-transparent font-medium text-fg-muted hover:text-fg-primary'
              }`}
            >
              {selected && <Check size={13} aria-hidden="true" />}
              {option.label}
            </button>
          );
        })}
      </div>
      <p
        className="m-0 min-w-0 break-words text-xs leading-relaxed text-fg-muted"
        aria-live="polite"
      >
        {sizeText(policy, mode, saving)}
      </p>
    </div>
  );
}
