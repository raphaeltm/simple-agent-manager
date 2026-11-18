/**
 * Low-key usage line for one profile: "● 5h ▂ 28%  Wk ▅ 69%  Opus ▁ 12%", in percent left
 * (the same meters as the new-chat picker). Colour appears only on windows at or below half;
 * tapping opens the same usage breakdown the chat header chip opens.
 */
import {
  credentialLimitSummaryAsOf,
  worstCredentialLimitLevel,
} from '@simple-agent-manager/shared';
import { Dialog } from '@simple-agent-manager/ui';
import { useId, useMemo, useState } from 'react';

import { LEVEL_LABELS, LEVEL_STYLES } from '../credential-limits/credential-limit-format';
import { CredentialLimitDetails } from '../credential-limits/CredentialLimitChip';
import { readUsageWindow, sortUsageWindows } from '../project-chat/profile-picker/usage-windows';
import { UsageMeters } from '../project-chat/profile-picker/UsageMeters';
import type { ProfileBudget } from './useProfileBudgets';

function Quiet({ children, tone }: Readonly<{ children: string; tone?: 'warning' }>) {
  return (
    <span
      className={`block min-w-0 truncate text-[11px] ${tone === 'warning' ? 'text-warning-fg' : 'text-fg-muted'}`}
      title={children}
    >
      {children}
    </span>
  );
}

export function ProfileUsageStrip({
  budget,
  profileName,
  now,
}: Readonly<{ budget: ProfileBudget | undefined; profileName: string; now?: number }>) {
  const [open, setOpen] = useState(false);
  const eyebrowId = useId();
  const headingId = useId();
  const usage = budget?.kind === 'account' ? budget.usage : null;
  // Recomputed when a poll delivers new usage, not on every parent render.
  const current = useMemo(
    () => (usage ? credentialLimitSummaryAsOf(usage, now ?? Date.now()) : null),
    [usage, now]
  );

  // Still loading: render nothing rather than a spinner that reflows the row.
  if (!budget) return null;
  if (budget.kind === 'platform') return <Quiet>SAM platform</Quiet>;
  if (budget.kind === 'none') return <Quiet>No account connected</Quiet>;
  if (budget.kind === 'paused') {
    return <Quiet tone="warning">{`${budget.label ?? 'Account'} paused`}</Quiet>;
  }
  if (!current || current.windows.length === 0) {
    return <Quiet>{`${budget.label} · no usage yet`}</Quiet>;
  }

  // The dot is the worst window, so it can never look calmer than the meters beside it.
  const level = worstCredentialLimitLevel(current.windows.map((window) => window.level));
  const dot = LEVEL_STYLES[level].color;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Usage for ${profileName} on ${budget.label}: ${LEVEL_LABELS[level]}. Open details`}
        title={budget.label}
        className="-mx-1 inline-flex min-w-0 max-w-full cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm border-0 bg-transparent px-1 py-0.5 text-[11px] text-fg-primary hover:bg-[var(--sam-glass-v2-well-shade)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        data-testid="profile-usage-strip"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
        />
        <UsageMeters
          windows={sortUsageWindows(
            current.windows.map((window) => readUsageWindow(window, now ?? Date.now()))
          )}
        />
      </button>
      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        aria-labelledby={`${eyebrowId} ${headingId}`}
        maxWidth="md"
      >
        <CredentialLimitDetails
          credential={current}
          now={now}
          eyebrowId={eyebrowId}
          headingId={headingId}
        />
      </Dialog>
    </>
  );
}

/** Room left on whichever window will stop this profile first; null when unknown. */
export function profileHeadroom(budget: ProfileBudget | undefined, now: number): number | null {
  if (budget?.kind !== 'account' || !budget.usage) return null;
  const current = credentialLimitSummaryAsOf(budget.usage, now);
  if (current.windows.some((window) => window.level === 'rejected')) return 0;
  const used = current.windows
    .map((window) => window.utilizationPercent)
    .filter((value): value is number => value !== null);
  return used.length > 0 ? Math.max(0, 100 - Math.max(...used)) : null;
}
