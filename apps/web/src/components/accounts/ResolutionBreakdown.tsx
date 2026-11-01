/**
 * "How SAM picks the account": one row per tier of the credential resolver, most
 * specific first, with what each tier did for this run. Kept behind a disclosure
 * and opened automatically only when something needs attention.
 */
import type { CCResolutionStepState, CCResolutionTier } from '@simple-agent-manager/shared';
import { Ban, Check, CircleDashed, Minus, SkipForward } from 'lucide-react';

import type { ExplainedStep, ProfileAccountExplanation } from './profile-account-resolution';
import { getAccountProvider } from './provider-meta';

const STATE_LABELS: Record<CCResolutionStepState, string> = {
  used: 'Used',
  skipped: 'Skipped',
  halted: 'Stops here',
  'not-set': 'Not set',
  'not-reached': 'Not checked',
};

const STATE_ICONS: Record<CCResolutionStepState, typeof Check> = {
  used: Check,
  skipped: SkipForward,
  halted: Ban,
  'not-set': CircleDashed,
  'not-reached': Minus,
};

function agentName(agentType: string): string {
  return getAccountProvider('agent', agentType).name;
}

function tierTitle(tier: CCResolutionTier, runAgentType: string): string {
  switch (tier) {
    case 'profile':
      return 'Your account for this profile';
    case 'project':
      return 'Your account for this project';
    case 'user':
      return `Your default ${agentName(runAgentType)} account`;
    case 'platform':
      return 'SAM platform';
  }
}

function stepDetail(step: ExplainedStep, runAgentType: string): string {
  const label = step.account?.label;
  switch (step.reason) {
    case 'agent-type-mismatch':
      return `Pinned account is for ${agentName(step.pinnedAgentType ?? runAgentType)}; this run uses ${agentName(runAgentType)}`;
    case 'paused':
    case 'configuration-inactive':
    case 'credential-inactive':
      return label ? `“${label}” is paused` : 'The account is paused';
    case 'configuration-missing':
    case 'credential-missing':
      return 'The account was removed';
    default:
      break;
  }
  if (step.tier === 'platform') {
    return step.state === 'not-set'
      ? `Not available for ${agentName(runAgentType)}`
      : 'Billed to SAM usage';
  }
  if (step.state === 'not-set') return 'None chosen';
  return label ?? '';
}

const ROW_TONE: Partial<Record<CCResolutionStepState, string>> = {
  used: 'bg-accent-tint',
  halted: 'bg-danger-tint',
  'not-reached': 'opacity-50',
};

export function ResolutionBreakdown({
  explanation,
}: Readonly<{ explanation: ProfileAccountExplanation }>) {
  return (
    <ol aria-label="How SAM picks the account" className="m-0 flex list-none flex-col gap-1 p-0">
      {explanation.steps.map((step, index) => {
        const Icon = STATE_ICONS[step.state];
        return (
          <li
            key={step.tier}
            className={`flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 ${ROW_TONE[step.state] ?? ''}`}
          >
            <span className="w-4 shrink-0 text-right text-[11px] text-fg-muted">{index + 1}</span>
            <Icon size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-fg-muted" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span className="text-xs text-fg-primary">
                  {tierTitle(step.tier, explanation.runAgentType)}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
                  {STATE_LABELS[step.state]}
                </span>
              </span>
              <span className="text-[11px] text-fg-muted [overflow-wrap:anywhere]">
                {stepDetail(step, explanation.runAgentType)}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
