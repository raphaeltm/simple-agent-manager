import { Lightbulb } from 'lucide-react';
import { Link } from 'react-router';

import type { SessionWorkingOnIdea } from './useSessionLinkedWork';

/**
 * "Working on <idea>" in the chat header.
 *
 * Which idea a chat is for is the single most useful thing to know about it, and it was
 * previously invisible: the link existed in the store and nowhere in the UI. The chip sits in
 * the always-visible header row beside the comment chip rather than in the Details disclosure,
 * for the same reason the comment chip does — it is a discovery affordance, so it has to be
 * visible before you know there is something to find.
 *
 * The chip shows ONE idea. A chat that works on several is unusual, and the Related panel lists
 * all of them; putting a list in the header row would push the ports and comment chips off a
 * 375px screen.
 */
export function SessionWorkingOnChip({
  projectId,
  workingOn,
}: Readonly<{ projectId: string; workingOn: SessionWorkingOnIdea }>) {
  const { idea, verb } = workingOn;
  return (
    <Link
      to={`/projects/${projectId}/ideas/${idea.ideaId}`}
      // `max-w-full` + `truncate`, not `shrink-0`: a 200-character idea title must give way
      // instead of pushing the chip row past the viewport. The row wraps, so on a phone the
      // chip gets a line of its own and may use all of it. The full title stays available as
      // the accessible name and the tooltip.
      className="inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium no-underline transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary sm:max-w-[22rem]"
      style={{
        color: 'var(--sam-color-accent-primary)',
        borderColor: 'color-mix(in srgb, var(--sam-color-accent-primary) 40%, transparent)',
        backgroundColor: 'color-mix(in srgb, var(--sam-color-accent-primary) 10%, transparent)',
      }}
      aria-label={`${verb} the idea ${idea.title} — open it`}
      title={`${verb}: ${idea.title}`}
      data-testid="session-working-on-chip"
    >
      <Lightbulb size={10} aria-hidden="true" className="shrink-0" />
      <span className="shrink-0">{verb}</span>
      <span className="min-w-0 truncate">{idea.title}</span>
    </Link>
  );
}
