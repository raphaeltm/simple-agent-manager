/**
 * The Agent setups and People tabs until their slices ship (spec idea
 * 01M7HTS38KX2G78JD0ESAGMKKH: S and P). Each says what it will show, so the tab is not a blank
 * promise. This is the one placeholder the Insights spec allows; those slices replace it.
 */
import { Pane } from '@simple-agent-manager/ui';
import { Hourglass } from 'lucide-react';
import { useLocation } from 'react-router';

type ComingTab = 'agent-setups' | 'people';

const COMING: Record<ComingTab, { title: string; body: string }> = {
  'agent-setups': {
    title: 'Agent setups',
    body: 'Which profiles, skills and models get work merged without rework, how long they take, and what they cost per merged pull request.',
  },
  people: {
    title: 'People',
    body: 'What is waiting on whom, how long reviews take to be picked up, and which questions the first person asked could answer.',
  },
};

function isComingTab(value: string | undefined): value is ComingTab {
  return value !== undefined && value in COMING;
}

/** One route component for the two tabs; the last path segment says which. */
export function ComingSoonTab() {
  const segment = useLocation().pathname.replace(/\/+$/, '').split('/').pop();
  const tab: ComingTab = isComingTab(segment) ? segment : 'agent-setups';
  const { title, body } = COMING[tab];
  return (
    <Pane
      className="flex min-w-0 flex-col items-center gap-2 px-6 py-12 text-center"
      aria-label={title}
      data-testid={`insights-coming-soon-${tab}`}
    >
      <Hourglass size={22} aria-hidden="true" className="text-fg-muted" />
      <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{title} is coming soon</h2>
      <p className="m-0 max-w-[420px] text-[13.5px] text-fg-muted">{body}</p>
    </Pane>
  );
}
