import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import {
  credentialLimitSummaryAsOf,
  credentialLimitWindowLabel,
  getAgentDefinition,
  isValidAgentType,
} from '@simple-agent-manager/shared';
import { chipClassName, Dialog, StatusBadge } from '@simple-agent-manager/ui';
import { Gauge } from 'lucide-react';
import { useId, useState } from 'react';

import {
  credentialChipText,
  credentialFamilyLabel,
  formatResetCountdown,
  formatSampledAgo,
  LEVEL_LABELS,
  LEVEL_STYLES,
  windowValueLabel,
} from './credential-limit-format';

/**
 * Compact usage chip for one credential ("Claude · 5h 72% · Week 31%") that opens
 * a details dialog listing every window with its reset countdown.
 *
 * A `Dialog` rather than the anchored `Popover`: the chip lives in the chat
 * header, which sits at the top of an `overflow` scroll container, and on a
 * 375px screen a five-window list with progress bars needs more room than an
 * anchored panel reliably has. A modal is never clipped by the header's
 * overflow (rule 56) and reads the same on phone and desktop.
 */
export function CredentialLimitChip({
  credential,
  now,
}: Readonly<{ credential: CredentialLimitCredentialSummary; now?: number }>) {
  const [open, setOpen] = useState(false);
  const eyebrowId = useId();
  const headingId = useId();
  // A window whose reset passed since its sample reads 0% here too (the API applies
  // the same rule at read time; this covers resets between polls).
  const current = credentialLimitSummaryAsOf(credential, now ?? Date.now());
  const text = credentialChipText(current);
  const style = LEVEL_STYLES[current.level];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Usage limits${current.credentialName ? ` for ${current.credentialName}` : ''}: ${text}. ${LEVEL_LABELS[current.level]}. Open details`}
        data-testid="credential-limit-chip"
        className={`${chipClassName()} cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
      >
        {/* The level colour rides on the gauge; the chip stays solid and neutral (SAM Glass). */}
        <Gauge size={14} strokeWidth={1.75} aria-hidden="true" style={{ color: style.color }} />
        <span className="truncate">{text}</span>
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

const CREDENTIAL_SOURCE_LABELS: Record<
  CredentialLimitCredentialSummary['credentialSource'],
  string
> = {
  user: 'Your account',
  project: 'Project account',
  platform: 'Platform account',
};

/** A window sample older than the credential's newest by this much gets its own age line. */
const STALE_WINDOW_SAMPLE_MS = 60_000;

function agentLabel(agentType: string | null): string | null {
  if (!agentType) return null;
  return isValidAgentType(agentType)
    ? (getAgentDefinition(agentType)?.name ?? agentType)
    : agentType;
}

/** Account usage breakdown: every window with its bar and reset countdown. */
export function CredentialLimitDetails({
  credential,
  now,
  eyebrowId,
  headingId,
}: Readonly<{
  credential: CredentialLimitCredentialSummary;
  now?: number;
  eyebrowId: string;
  headingId: string;
}>) {
  const at = now ?? Date.now();
  const sourceLabel = CREDENTIAL_SOURCE_LABELS[credential.credentialSource];
  // The account name is how the user recognises it; without one, say whose it is.
  const title = credential.credentialName ?? sourceLabel;
  const meta = [
    credential.credentialName ? sourceLabel : null,
    agentLabel(credential.agentType),
    formatSampledAgo(credential.observedAt, at),
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-4" data-testid="credential-limit-details">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--sam-radius-control)] sam-well"
            aria-hidden="true"
          >
            <Gauge
              size={18}
              strokeWidth={1.75}
              style={{ color: LEVEL_STYLES[credential.level].color }}
            />
          </span>
          <div className="min-w-0">
            <p
              id={eyebrowId}
              className="m-0 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted"
            >
              {credentialFamilyLabel(credential)} usage
            </p>
            <h2
              id={headingId}
              className="m-0 mt-0.5 line-clamp-2 text-base font-semibold leading-snug text-fg-primary break-words"
              title={title}
              data-testid="credential-limit-account-name"
            >
              {title}
            </h2>
            <p className="m-0 mt-0.5 text-xs text-fg-muted break-words">{meta.join(' · ')}</p>
          </div>
        </div>
        <span className="shrink-0 whitespace-nowrap">
          <StatusBadge
            status={credential.level}
            label={LEVEL_LABELS[credential.level]}
            pulse={false}
          />
        </span>
      </div>
      <ul className="sam-well m-0 flex list-none flex-col rounded-[var(--sam-radius-control)] p-0">
        {credential.windows.map((window) => {
          const percent = window.utilizationPercent ?? 0;
          const reset = formatResetCountdown(window.resetsAt, at);
          const label = credentialLimitWindowLabel(window.windowType, window.windowMinutes);
          const color = LEVEL_STYLES[window.level].color;
          // An unsampled OK window has nothing to celebrate: say it in muted text.
          const valueColor =
            window.utilizationPercent === null && window.level === 'ok'
              ? 'var(--sam-color-fg-muted)'
              : color;
          const staleSample = credential.observedAt - window.observedAt >= STALE_WINDOW_SAMPLE_MS;
          return (
            <li
              key={window.windowType}
              className="border-t border-[var(--sam-hairline)] px-3.5 py-3 first:border-t-0"
              data-testid="credential-limit-window"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-fg-primary break-words">{label}</span>
                <span
                  className="shrink-0 text-sm font-semibold tabular-nums"
                  style={{ color: valueColor }}
                >
                  {windowValueLabel(window)}
                </span>
              </div>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--sam-glass-v2-well-shade)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                aria-label={`${label} utilization`}
              >
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(0, percent))}%`,
                    backgroundColor: color,
                    boxShadow: `0 0 8px ${color}`,
                  }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-xs text-fg-muted">
                <span className={window.resetElapsed ? 'text-info-fg' : undefined}>
                  {reset ?? 'reset time unknown'}
                  {window.resetElapsed && ' · no sample since'}
                </span>
                {staleSample && <span>{formatSampledAgo(window.observedAt, at)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-[11px] leading-relaxed text-fg-muted">
        Values are the latest samples SAM saw while an agent ran on this credential, not a live
        quote from the provider.
      </p>
    </div>
  );
}
