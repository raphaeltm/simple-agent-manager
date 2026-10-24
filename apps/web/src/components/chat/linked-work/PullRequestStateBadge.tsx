/**
 * A pull request's state, as a word plus its own glyph.
 *
 * Renders NOTHING when `state` is null. SAM stores PR state separately from the link store, so
 * a linked PR legitimately has no state yet — on a deployment whose PR tracking has not
 * recorded this PR, and on every PR before that tracking shipped. A grey "Unknown" pill there
 * would assert something the server did not say, so the row simply shows the PR number and no
 * pill, and the pill appears the moment state arrives.
 *
 * Never colour-only: each state carries a distinct icon and its own word, so the distinction
 * survives a monochrome display and a screen reader (`apps/web/.claude/rules/04-ui-standards.md`).
 */
import type { PullRequestState } from '@simple-agent-manager/shared';
import type { LucideIcon } from 'lucide-react';
import { CircleDot, CircleSlash, GitMerge, GitPullRequestDraft } from 'lucide-react';

interface StateMeta {
  label: string;
  icon: LucideIcon;
  accent: string;
}

const STATE_META: Record<PullRequestState['state'], StateMeta> = {
  open: { label: 'Open', icon: CircleDot, accent: 'var(--sam-color-success-fg)' },
  merged: { label: 'Merged', icon: GitMerge, accent: 'var(--sam-color-purple)' },
  closed: { label: 'Closed', icon: CircleSlash, accent: 'var(--sam-color-danger-fg)' },
};

const DRAFT_META: StateMeta = {
  label: 'Draft',
  icon: GitPullRequestDraft,
  accent: 'var(--sam-color-fg-muted)',
};

/** Checks are only worth a word while they can still change a decision. */
const CHECKS_LABEL: Record<NonNullable<PullRequestState['checksState']>, string | null> = {
  pending: 'Checks running',
  success: 'Checks passed',
  failure: 'Checks failing',
  // "neutral" means the runs reported nothing conclusive. Saying so adds no information.
  neutral: null,
};

const CHECKS_ACCENT: Record<NonNullable<PullRequestState['checksState']>, string> = {
  pending: 'var(--sam-color-warning-fg)',
  success: 'var(--sam-color-success-fg)',
  failure: 'var(--sam-color-danger-fg)',
  neutral: 'var(--sam-color-fg-muted)',
};

export function PullRequestStateBadge({
  state,
  showChecks = true,
}: Readonly<{ state: PullRequestState | null; showChecks?: boolean }>) {
  if (!state) return null;
  // A draft PR is open, but "Draft" is the fact that decides whether anyone should look at it.
  const meta = state.state === 'open' && state.isDraft ? DRAFT_META : STATE_META[state.state];
  const checksLabel = showChecks && state.checksState ? CHECKS_LABEL[state.checksState] : null;

  return (
    <>
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none"
        style={{
          backgroundColor: `color-mix(in srgb, ${meta.accent} 14%, transparent)`,
          color: meta.accent,
        }}
        // `stale` means the stored snapshot may lag GitHub. Worth disclosing, not worth a
        // second pill competing with the state itself.
        title={state.stale ? `${meta.label} — may be out of date` : meta.label}
        data-testid="pr-state-badge"
        data-state={state.isDraft && state.state === 'open' ? 'draft' : state.state}
      >
        <meta.icon size={10} aria-hidden="true" />
        {meta.label}
      </span>
      {checksLabel && state.checksState && (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium"
          style={{ color: CHECKS_ACCENT[state.checksState] }}
          data-testid="pr-checks-state"
        >
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] rounded-full"
            style={{ backgroundColor: 'currentColor' }}
          />
          {checksLabel}
        </span>
      )}
    </>
  );
}
