import { formatRelativeTime } from '../../../lib/time-utils';
import type { DisplayItem } from '../tool-call-groups';

/**
 * Which message a comment thread is on, in words. Message ids are UUIDs, which mean nothing
 * to a reader, so comment surfaces say "The agent's reply · 5m ago" or "Olivia's message".
 */
export interface CommentedMessageLabel {
  /** "The agent's reply", "Your message", "Olivia's message", or "Earlier message". */
  title: string;
  /** The same words mid-sentence: "the agent's reply", "an earlier message". */
  phrase: string;
  /** Relative time of the message; null when it is not loaded. */
  when: string | null;
  /** False when the message is not loaded yet, so who wrote it is unknown. */
  loaded: boolean;
}

export type DescribeCommentedMessage = (messageId: string) => CommentedMessageLabel;

const EARLIER_MESSAGE: CommentedMessageLabel = {
  title: 'Earlier message',
  phrase: 'an earlier message',
  when: null,
  loaded: false,
};

function personMessage(name: string, timestamp: number): CommentedMessageLabel {
  const words = `${name}'s message`;
  return { title: words, phrase: words, when: formatRelativeTime(timestamp), loaded: true };
}

/**
 * Describe messages from the loaded conversation. A thread on a message that has not been
 * paged in yet reads "Earlier message" rather than guessing who wrote it.
 */
export function buildCommentedMessageDescriber(
  items: readonly DisplayItem[],
  { ownerName, viewerIsOwner }: { ownerName: string; viewerIsOwner: boolean }
): DescribeCommentedMessage {
  const labels = new Map<string, CommentedMessageLabel>();
  for (const item of items) {
    if (item.kind === 'agent_message') {
      labels.set(item.id, {
        title: "The agent's reply",
        phrase: "the agent's reply",
        when: formatRelativeTime(item.timestamp),
        loaded: true,
      });
    } else if (item.kind === 'user_message') {
      if (item.attribution) {
        // A teammate's prompt, or a comment someone sent to the agent.
        labels.set(
          item.id,
          personMessage(item.attribution.senderName ?? 'A teammate', item.timestamp)
        );
      } else if (viewerIsOwner) {
        labels.set(item.id, {
          title: 'Your message',
          phrase: 'your message',
          when: formatRelativeTime(item.timestamp),
          loaded: true,
        });
      } else {
        labels.set(item.id, personMessage(ownerName, item.timestamp));
      }
    }
  }
  return (messageId) => labels.get(messageId) ?? EARLIER_MESSAGE;
}

/** "The agent's reply · 5m ago" for visible text. */
export function formatCommentedMessageLabel({ title, when }: CommentedMessageLabel): string {
  return when ? `${title} · ${when}` : title;
}

/** Accessible name for the control that scrolls to the message. */
export function showCommentedMessageName({ phrase, when }: CommentedMessageLabel): string {
  return when
    ? `Show ${phrase}, ${when.toLowerCase()}, in the conversation`
    : `Show ${phrase} in the conversation`;
}
