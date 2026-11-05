import type { PromptDeliveryIntent } from '@simple-agent-manager/shared';
import { SegmentedControl, type SegmentedOption } from '@simple-agent-manager/ui';
import { CornerDownRight, ListEnd } from 'lucide-react';

import { useIsMobile } from '../../hooks/useIsMobile';

// Hoisted: the options never change, so the control keeps stable props across renders.
const OPTIONS: SegmentedOption<PromptDeliveryIntent>[] = [
  {
    value: 'queue',
    label: 'Queue next',
    icon: <ListEnd size={14} aria-hidden="true" />,
    title: 'Send after the current turn finishes',
  },
  {
    value: 'steer',
    label: 'Steer now',
    icon: <CornerDownRight size={14} aria-hidden="true" />,
    title: 'Add to the turn the agent is working on',
  },
];

/**
 * While the agent works, the choice between adding a message to the running turn
 * and sending it after the turn. Files always go with the next message, because a
 * steer carries text only (the server refuses a steer with attachments).
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
  const isMobile = useIsMobile();
  const hint = hasAttachments
    ? 'Messages with files are sent after the current turn.'
    : value === 'steer'
      ? 'Added to the current turn if the agent can take it, otherwise sent next.'
      : 'Sent after the current turn finishes.';
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
      {!hasAttachments && (
        <SegmentedControl
          options={OPTIONS}
          value={value}
          onChange={onChange}
          label="When to deliver your message"
          size={isMobile ? 'lg' : 'md'}
          // Fixed width past mobile: shrink-to-content truncates the selected (bolder) label.
          className="w-full shrink-0 sm:w-64"
        />
      )}
      <p className="m-0 min-w-0 text-xs text-fg-muted" aria-live="polite">
        {hint}
      </p>
    </div>
  );
}
