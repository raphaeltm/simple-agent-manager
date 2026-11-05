import type { UserMessageDelivery } from '@simple-agent-manager/acp-client';
import { Check, CircleHelp, Clock, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { NOTICE_TONES, type NoticeTone } from '../chat-notices/notice-tones';

// Shown on the chip itself: a tooltip alone never reaches a touch screen.
const QUEUED_REASON_SHORT: Record<NonNullable<UserMessageDelivery['reason']>, string | null> = {
  turn_finished: 'turn had ended',
  agent_asleep: 'agent was asleep',
  not_supported: "agent can't steer",
  other: null,
};

const QUEUED_REASON: Record<NonNullable<UserMessageDelivery['reason']>, string> = {
  turn_finished: 'the agent had finished its turn',
  agent_asleep: 'the agent was asleep',
  not_supported: "this agent can't take messages mid-turn",
  other: "it couldn't be added to the current turn",
};

function chipContent(delivery: UserMessageDelivery): {
  tone: NoticeTone;
  icon: ReactNode;
  label: string;
  detail: string;
} {
  switch (delivery.status) {
    case 'steering':
      return {
        tone: 'progress',
        icon: (
          <LoaderCircle
            size={13}
            strokeWidth={2}
            className="animate-spin motion-reduce:animate-none"
          />
        ),
        label: 'Steering…',
        detail: 'Adding this to what the agent is doing now.',
      };
    case 'steered':
      return {
        tone: 'success',
        icon: <Check size={13} strokeWidth={2.25} />,
        label: 'Added to current turn',
        detail:
          'The agent took this into the turn it was running. It acts on it at its next step, so it may finish the step it is on first.',
      };
    case 'queued_instead':
      return {
        tone: 'info',
        icon: <Clock size={13} strokeWidth={2} />,
        label: ['Sent as next message', QUEUED_REASON_SHORT[delivery.reason ?? 'other']]
          .filter(Boolean)
          .join(' · '),
        detail: `Queued for the agent's next turn because ${QUEUED_REASON[delivery.reason ?? 'other']}.`,
      };
    case 'unconfirmed':
      return {
        tone: 'info',
        icon: <CircleHelp size={13} strokeWidth={2} />,
        label: 'Delivery unconfirmed',
        detail:
          "SAM couldn't confirm whether the agent got this, so it won't send it again. Resend it if the agent didn't respond to it.",
      };
    case 'not_delivered':
      return {
        tone: 'danger',
        icon: <X size={13} strokeWidth={2.25} />,
        label: 'Not delivered',
        detail: 'This message did not reach the agent.',
      };
  }
}

/**
 * Below a message sent with "Steer now": what the agent's runtime did with it. It
 * never claims the agent read or acted on it; "added" means the runtime took it.
 */
export function UserMessageDeliveryChip({ delivery }: { delivery: UserMessageDelivery }) {
  const { tone, icon, label, detail } = chipContent(delivery);
  const t = NOTICE_TONES[tone];
  return (
    <div className="-mt-2 mb-4 flex justify-end" data-testid="user-message-delivery">
      <span
        className="inline-flex min-w-0 max-w-[92%] items-center gap-1.5 rounded-full border bg-[var(--sam-chip-bg)] px-2 py-0.5 text-xs text-fg-muted sm:max-w-[80%]"
        style={{ borderColor: t.edge }}
        title={detail}
      >
        <span aria-hidden="true" className="flex shrink-0" style={{ color: t.fg }}>
          {icon}
        </span>
        <span
          className="min-w-0 break-words font-medium text-fg-primary"
          data-testid="user-message-delivery-label"
        >
          {label}
        </span>
        <span className="sr-only">{detail}</span>
      </span>
    </div>
  );
}
