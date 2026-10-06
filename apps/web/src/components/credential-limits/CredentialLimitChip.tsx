import type { CredentialLimitCredentialSummary } from '@simple-agent-manager/shared';
import { credentialLimitWindowLabel } from '@simple-agent-manager/shared';
import { Dialog, StatusBadge } from '@simple-agent-manager/ui';
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
  const headingId = useId();
  const text = credentialChipText(credential);
  const style = LEVEL_STYLES[credential.level];

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Usage limits: ${text}. ${LEVEL_LABELS[credential.level]}. Open details`}
        data-testid="credential-limit-chip"
        className="inline-flex max-w-full items-center gap-1 rounded border border-transparent px-1.5 py-0.5 text-[10px] font-medium shrink-0 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
        style={{ backgroundColor: style.background, color: style.color }}
      >
        <Gauge size={10} aria-hidden="true" />
        <span className="truncate">{text}</span>
      </button>
      <Dialog
        isOpen={open}
        onClose={() => setOpen(false)}
        aria-labelledby={headingId}
        maxWidth="sm"
      >
        <CredentialLimitDetails credential={credential} now={now} headingId={headingId} />
      </Dialog>
    </>
  );
}

const CREDENTIAL_SOURCE_LABELS: Record<
  CredentialLimitCredentialSummary['credentialSource'],
  string
> = {
  user: 'Your credential',
  project: 'Project credential',
  platform: 'Platform credential',
};

function CredentialLimitDetails({
  credential,
  now,
  headingId,
}: Readonly<{ credential: CredentialLimitCredentialSummary; now?: number; headingId?: string }>) {
  const at = now ?? Date.now();
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="credential-limit-details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 text-sm font-semibold text-fg-primary">
            {credentialFamilyLabel(credential)} usage
          </h2>
          <p className="m-0 mt-0.5 text-xs text-fg-muted break-words">
            {CREDENTIAL_SOURCE_LABELS[credential.credentialSource]}
            {credential.agentType ? ` · ${credential.agentType}` : ''} ·{' '}
            {formatSampledAgo(credential.observedAt, at)}
          </p>
        </div>
        <StatusBadge
          status={credential.level}
          label={LEVEL_LABELS[credential.level]}
          pulse={false}
        />
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {credential.windows.map((window) => {
          const percent = window.utilizationPercent ?? 0;
          const reset = formatResetCountdown(window.resetsAt, at);
          return (
            <li
              key={window.windowType}
              className="rounded-md border border-border-default bg-inset px-3 py-2"
              data-testid="credential-limit-window"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium text-fg-primary break-words">
                  {credentialLimitWindowLabel(window.windowType, window.windowMinutes)}
                </span>
                <span
                  className="shrink-0 font-semibold"
                  style={{ color: LEVEL_STYLES[window.level].color }}
                >
                  {windowValueLabel(window)}
                </span>
              </div>
              <div
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                aria-label={`${credentialLimitWindowLabel(window.windowType, window.windowMinutes)} utilization`}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, percent))}%`,
                    backgroundColor: LEVEL_STYLES[window.level].color,
                  }}
                />
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-fg-muted">
                <span>{reset ?? 'reset time unknown'}</span>
                <span>{formatSampledAgo(window.observedAt, at)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="m-0 text-[11px] text-fg-muted">
        Values are the latest samples SAM saw while an agent ran on this credential, not a live
        quote from the provider.
      </p>
    </div>
  );
}
