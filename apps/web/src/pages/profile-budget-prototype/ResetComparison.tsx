/**
 * Before/after for stale windows whose reset already passed. "Before" renders
 * the production chip and today's formatting; "after" applies `effectiveWindow`.
 */
import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { worstCredentialLimitLevel } from '@simple-agent-manager/shared';

import {
  formatResetCountdown,
  windowValueLabel,
} from '../../components/credential-limits/credential-limit-format';
import { CredentialLimitChip } from '../../components/credential-limits/CredentialLimitChip';
import { effectiveWindow, effectiveWindows, levelColor } from './budget';
import { ACCOUNTS, NOW } from './mock-data';
import { UsageRow } from './parts';

function withResetsApplied(
  account: CredentialLimitCredentialSummary
): CredentialLimitCredentialSummary {
  const windows = account.windows.map((w) => {
    const eff = effectiveWindow(w, NOW);
    return eff.resetElapsed ? { ...w, utilizationPercent: 0, level: 'ok' as const } : w;
  });
  return { ...account, windows, level: worstCredentialLimitLevel(windows.map((w) => w.level)) };
}

const STALE = ACCOUNTS.filter((a) =>
  a.windows.some((w) => w.resetsAt !== null && w.resetsAt <= NOW)
);

export function ResetComparison() {
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 text-[13px] leading-relaxed text-fg-muted">
        A sample taken before a window&rsquo;s reset time says nothing about usage after it. Once{' '}
        <code className="font-mono text-xs">resetsAt</code> has passed, the window should read 0%
        and drop back to OK until a fresh sample arrives — and say that it reset, so a 0% never
        looks like a measurement.
      </p>
      {STALE.map((account) => (
        <div key={account.credentialReference} className="grid gap-2 sm:grid-cols-2">
          <section className="min-w-0 rounded-md glass-surface p-3" aria-label="Today">
            <p className="m-0 mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted">
              Today
            </p>
            <div className="flex min-w-0 flex-wrap">
              <CredentialLimitChip credential={account} now={NOW} />
            </div>
            <ul className="m-0 mt-2.5 list-none rounded-[var(--sam-radius-control)] sam-well p-0">
              {account.windows.map((w) => (
                <li
                  key={w.windowType}
                  className="flex items-baseline justify-between gap-2 border-t border-[var(--sam-hairline)] px-3 py-2 text-xs first:border-t-0"
                >
                  <span className="text-fg-primary">{effectiveWindow(w, NOW).label}</span>
                  <span className="text-right">
                    <span className="font-semibold" style={{ color: levelColor(w.level) }}>
                      {windowValueLabel(w)}
                    </span>
                    <span className="block text-[11px] text-fg-muted">
                      {formatResetCountdown(w.resetsAt, NOW)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="min-w-0 rounded-md glass-surface p-3" aria-label="Proposed">
            <p className="m-0 mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-info-fg">
              Proposed
            </p>
            <div className="flex min-w-0 flex-wrap">
              <CredentialLimitChip credential={withResetsApplied(account)} now={NOW} />
            </div>
            <div className="mt-2.5 flex flex-col gap-2 rounded-[var(--sam-radius-control)] sam-well px-3 py-2.5">
              {effectiveWindows(account, NOW).map((w) => (
                <UsageRow key={w.raw.windowType} window={w} stacked />
              ))}
            </div>
          </section>
        </div>
      ))}
    </div>
  );
}
