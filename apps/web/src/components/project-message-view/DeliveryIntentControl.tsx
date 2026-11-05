import type { PromptDeliveryIntent } from '@simple-agent-manager/shared';
import { CornerDownRight, ListEnd } from 'lucide-react';

const CHIP: Record<
  PromptDeliveryIntent,
  { label: string; name: string; detail: string; tone: string }
> = {
  steer: {
    label: 'Steer',
    name: 'Steer now',
    detail: 'Joins this turn if the agent can take it, else sent next.',
    tone: 'border-[rgba(34,197,94,0.35)] bg-[rgba(34,197,94,0.1)] text-[var(--sam-status-success-fg)]',
  },
  queue: {
    label: 'Queue',
    name: 'Queue next',
    detail: 'Sent when this turn ends.',
    tone: 'border-[rgba(148,163,184,0.3)] bg-[rgba(148,163,184,0.08)] text-fg-primary',
  },
};

/**
 * What the composer's placeholder says while the agent works, so no hint row is needed. Kept
 * short enough for one line in a 375px composer: a wrapped placeholder is clipped.
 */
export function deliveryIntentPlaceholder(
  intent: PromptDeliveryIntent,
  hasAttachments: boolean
): string {
  return intent === 'steer' && !hasAttachments ? 'Steer the agent...' : 'Queue next...';
}

/**
 * While the agent works, the choice between adding a message to the running turn and
 * sending it after the turn: one chip in the lifecycle dock's row, tapped to switch, so it
 * costs the composer no height. Files always go with the next message, because a steer
 * carries text only (the server refuses a steer with attachments), so the chip then shows
 * Queue and cannot be switched.
 */
export function DeliveryIntentControl({
  value,
  onChange,
  hasAttachments,
}: {
  value: PromptDeliveryIntent;
  onChange: (value: PromptDeliveryIntent) => void;
  hasAttachments: boolean;
}) {
  const shown: PromptDeliveryIntent = hasAttachments ? 'queue' : value;
  const other: PromptDeliveryIntent = shown === 'steer' ? 'queue' : 'steer';
  const chip = CHIP[shown];
  const Icon = shown === 'steer' ? CornerDownRight : ListEnd;
  return (
    <button
      type="button"
      disabled={hasAttachments}
      onClick={() => onChange(other)}
      aria-label={
        hasAttachments
          ? `${chip.name}: messages with files are sent when this turn ends`
          : `${chip.name}. Switch to ${CHIP[other].name}`
      }
      title={hasAttachments ? 'Messages with files are sent when this turn ends.' : chip.detail}
      data-testid="delivery-intent-chip"
      data-intent={shown}
      className={`pointer-events-auto flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring disabled:cursor-default disabled:opacity-60 ${chip.tone}`}
    >
      <Icon size={13} aria-hidden="true" />
      {chip.label}
    </button>
  );
}
