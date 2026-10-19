import type { SessionAccessDurationMinutes } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ArrowLeft } from 'lucide-react';
import { type RefObject, useId, useState } from 'react';

import { ACCESS_DURATION_OPTIONS, accessClockTime } from './session-access-time';

/** How the dialog talks about the owner, from the viewer's side: "your" when it is them. */
export interface OwnerWords {
  /** "your" / "Prakash's" */
  possessive: string;
  /** "you" / "Prakash" — who agents are billed to. */
  object: string;
  /** "my" / "Prakash's" — for the acknowledgement the viewer ticks. */
  firstPersonPossessive: string;
}

/** Who is being given access, and whether this extends access they already have. */
export interface ShareTarget {
  userId: string;
  name: string;
  renewing: boolean;
}

/**
 * The share dialog's confirm step: what sharing means, how long it lasts (a required choice of
 * 5, 10, 30 or 60 minutes with no default), and the shared-accounts acknowledgement. Renewing
 * goes through the same step, because it hands over the same control for a new period.
 * Split out of `SessionShareDialog` (`.claude/rules/18-file-size-limits.md`).
 */
export function SessionShareConfirmStep({
  target,
  words,
  headingId,
  headingRef,
  now,
  viewerExpiresAt,
  pending,
  error,
  onBack,
  onConfirm,
}: Readonly<{
  target: ShareTarget;
  words: OwnerWords;
  headingId: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** The server's clock. */
  now: number;
  /** When the viewer's own access ends, if they are not the owner: onward access stops then too. */
  viewerExpiresAt: number | null;
  pending: boolean;
  error: string | null;
  onBack: () => void;
  onConfirm: (durationMinutes: SessionAccessDurationMinutes) => void;
}>) {
  const durationName = useId();
  const endsAtId = useId();
  const [durationMinutes, setDurationMinutes] = useState<SessionAccessDurationMinutes | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const name = target.name;

  const chosenEnd = durationMinutes === null ? null : now + durationMinutes * 60_000;
  const cappedByViewer =
    chosenEnd !== null && viewerExpiresAt !== null && viewerExpiresAt < chosenEnd;
  const endsAt = chosenEnd === null ? null : cappedByViewer ? viewerExpiresAt : chosenEnd;

  return (
    <section aria-labelledby={headingId} className="mt-4">
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-sm font-semibold text-fg-primary focus:outline-none [overflow-wrap:anywhere]"
      >
        {target.renewing ? `Renew ${name}'s access?` : `Share with ${name}?`}
      </h3>
      <ul className="mt-2 mb-0 flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-fg-primary">
        <li>
          {name} can send messages, stop or archive the chat, and answer the agent — just like you.
        </li>
        <li>
          Everything runs on {words.possessive} accounts: AI subscription or API key, GitHub access
          and compute. Agents it starts are billed to {words.object}.
        </li>
        <li>
          The agent can read {words.possessive} keys, so {name} may be able to see them. Only share
          with people you trust.
        </li>
        <li>
          Access ends on its own after the time you choose, or when it&apos;s revoked. Ending it
          doesn&apos;t undo what {name} did or stop work the agent already started, and keys they
          copied keep working until they&apos;re replaced.
        </li>
      </ul>

      <fieldset className="m-0 mt-4 min-w-0 border-0 p-0" aria-describedby={endsAtId}>
        <legend className="p-0 text-sm font-medium text-fg-primary">How long?</legend>
        <div className="mt-2 grid grid-cols-4 gap-2">
          {ACCESS_DURATION_OPTIONS.map((option) => (
            <label
              key={option.minutes}
              className="flex min-h-11 min-w-0 cursor-pointer items-center justify-center rounded-md border border-border-default bg-inset px-1 text-center text-sm text-fg-primary transition-colors hover:bg-surface-hover has-[:checked]:border-accent has-[:checked]:bg-accent-tint has-[:checked]:font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus-ring"
            >
              <input
                type="radio"
                name={durationName}
                value={option.minutes}
                checked={durationMinutes === option.minutes}
                onChange={() => setDurationMinutes(option.minutes)}
                required
                className="sr-only"
              />
              {option.label}
            </label>
          ))}
        </div>
        <p id={endsAtId} className="m-0 mt-2 text-xs text-fg-muted" aria-live="polite">
          {endsAt === null
            ? 'Choose how long access lasts.'
            : cappedByViewer
              ? `Ends at ${accessClockTime(endsAt)}, when your own access ends.`
              : `Ends at ${accessClockTime(endsAt)}.`}
        </p>
      </fieldset>

      <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border-default bg-inset px-3 py-2.5 text-sm text-fg-primary">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
        />
        <span>I understand this runs on {words.firstPersonPossessive} accounts</span>
      </label>
      {error && (
        <p
          role="alert"
          className="mt-3 mb-0 rounded-md border border-danger/30 bg-danger-tint px-3 py-2 text-sm text-danger-fg [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back
        </Button>
        <Button
          onClick={() => {
            if (durationMinutes !== null) onConfirm(durationMinutes);
          }}
          disabled={!acknowledged || durationMinutes === null}
          loading={pending}
        >
          {target.renewing ? 'Renew' : 'Share'}
        </Button>
      </div>
    </section>
  );
}
