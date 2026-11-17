/**
 * The Agent setups tab until its slice ships (spec idea 01M7HTS38KX2G78JD0ESAGMKKH: S). It says
 * what it will show, so the tab is not a blank promise. This is the one placeholder the Insights
 * spec allows; slice S replaces it and deletes this file.
 */
import { Pane } from '@simple-agent-manager/ui';
import { Hourglass } from 'lucide-react';

export function ComingSoonTab() {
  return (
    <Pane
      className="flex min-w-0 flex-col items-center gap-2 px-6 py-12 text-center"
      aria-label="Agent setups"
      data-testid="insights-coming-soon-agent-setups"
    >
      <Hourglass size={22} aria-hidden="true" className="text-fg-muted" />
      <h2 className="m-0 text-[15px] font-semibold text-fg-primary">Agent setups is coming soon</h2>
      <p className="m-0 max-w-[420px] text-[13.5px] text-fg-muted">
        Which profiles, skills and models get work merged without rework, how long they take, and
        what they cost per merged pull request.
      </p>
    </Pane>
  );
}
