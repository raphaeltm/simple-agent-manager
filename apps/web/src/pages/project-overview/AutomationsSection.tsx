/**
 * Automations: each failing automation as one line with its fix button, then the next thing
 * that starts on its own. Built from the Automation page's own model (`useAutomationData`,
 * `attentionItems`, `comingUp`) and its fix button (`AttentionLine`), so "failing" and "fix"
 * mean exactly what they mean there.
 */
import { CalendarClock } from 'lucide-react';
import { Link } from 'react-router';

import { automationPaths } from '../../lib/automation-routes';
import { formatTimeFromNow } from '../../lib/time-utils';
import { useAutomationAccess, useAutomationData } from '../automation/data';
import { attentionItems, comingUp, isFinished } from '../automation/model';
import { AttentionLine } from '../automation/overview-sections';
import { Section, SectionHead, SectionNote } from './sections';

export function AutomationsSection({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const data = useAutomationData(projectId);
  const { canWrite } = useAutomationAccess();
  const failing = attentionItems(data.items);
  const [next] = comingUp(data.items, 1);
  const live = data.items.filter((item) => !isFinished(item)).length;
  return (
    <Section label="Automations" className={className}>
      <SectionHead
        title="Automations"
        count={
          data.isPending
            ? undefined
            : failing.length > 0
              ? `${failing.length} failing`
              : live || undefined
        }
        tone={failing.length > 0 ? 'danger' : undefined}
        to={automationPaths.overview(projectId)}
        linkLabel="All"
      />
      {failing.length > 0 && (
        <div className="flex flex-col px-1" data-testid="overview-automation-failing">
          {failing.map((item) => (
            <AttentionLine
              key={`${item.kind}:${item.id}`}
              item={item}
              attention={item.attention}
              canWrite={canWrite}
            />
          ))}
        </div>
      )}
      {next ? (
        <Link
          to={automationPaths.detail(projectId, next.kind, next.id)}
          className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-md px-2 py-1 no-underline hover:bg-surface-hover"
          data-testid="overview-automation-next"
        >
          <CalendarClock size={16} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <span className="flex min-w-0 flex-col">
            <span className="line-clamp-2 break-words text-sm font-medium text-fg-primary [overflow-wrap:anywhere]">
              {next.name}
            </span>
            <span className="text-xs text-fg-muted">Next run {formatTimeFromNow(next.nextAt)}</span>
          </span>
        </Link>
      ) : data.isPending ? (
        <SectionNote>Loading…</SectionNote>
      ) : data.failed.length > 0 && data.items.length === 0 ? (
        <SectionNote>Couldn’t load automations.</SectionNote>
      ) : failing.length === 0 ? (
        <SectionNote>
          {live > 0 ? 'Nothing scheduled to run next.' : 'No automations yet.'}
        </SectionNote>
      ) : null}
    </Section>
  );
}
