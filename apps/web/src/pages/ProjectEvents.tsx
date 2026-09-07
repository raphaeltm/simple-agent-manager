import { Button } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';

import { ChannelsPanel } from '../components/project-events/ChannelsPanel';
import { Feedback, linkClass } from '../components/project-events/EventUi';
import { SchedulesPanel } from '../components/project-events/SchedulesPanel';
import { StandingWatchesPanel } from '../components/project-events/StandingWatchesPanel';
import { SubscriptionsPanel } from '../components/project-events/SubscriptionsPanel';
import { useQueryScope } from '../hooks/useQueryScope';
import { getProjectMembers } from '../lib/api';
import { useProjectContext } from './ProjectContext';

const sections = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'watches', label: 'Standing watches' },
  { id: 'channels', label: 'Channels' },
] as const;

export function ProjectEvents() {
  const { projectId, project } = useProjectContext();
  const scope = useQueryScope();
  const [params, setParams] = useSearchParams();
  const section = sections.find((item) => item.id === params.get('section'))?.id ?? 'subscriptions';
  const sessionId = params.get('sessionId') || undefined;
  const members = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'members'],
    queryFn: () => getProjectMembers(projectId),
    enabled: Boolean(scope),
  });
  const member = members.data?.members.find(
    (item) => item.userId === scope && item.status === 'active'
  );
  const canWrite = project?.userId === scope || Boolean(member && member.role !== 'viewer');
  const creatorName = (id: string) => {
    const creator = members.data?.members.find((item) => item.userId === id);
    return creator?.user?.name || (id === scope ? 'You' : id);
  };
  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="space-y-2">
        <h1 className="sam-type-page-title m-0">Events</h1>
        <p className="m-0 text-sm text-fg-muted">
          Delivery, scheduled work, standing watches, and agent channels for this project.
        </p>
      </header>
      {sessionId && (
        <div className="glass-surface rounded-lg border border-border-default p-3 space-y-2">
          <p className="m-0 text-sm break-words">
            Subscriptions, schedules, and standing watches are scoped to{' '}
            <Link className={linkClass} to={`/projects/${projectId}/chat/${sessionId}`}>
              session {sessionId.slice(0, 8)}
            </Link>
            . Channels show the whole project.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete('sessionId');
                return next;
              })
            }
          >
            Show whole project
          </Button>
        </div>
      )}
      {!canWrite && (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {members.isPending
            ? 'Checking project write access…'
            : 'You can view events. Project write access is required to create or change schedules, watches, and subscriptions.'}
        </p>
      )}
      <Feedback error={members.error} />
      <nav aria-label="Event sections" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {sections.map((item) => (
          <Button
            key={item.id}
            variant={item.id === section ? 'primary' : 'secondary'}
            aria-pressed={item.id === section}
            className="min-w-0 !whitespace-normal"
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set('section', item.id);
                return next;
              })
            }
          >
            {item.label}
          </Button>
        ))}
      </nav>
      <div key={`${projectId}:${scope}:${sessionId ?? ''}:${section}`}>
        {section === 'subscriptions' && (
          <SubscriptionsPanel projectId={projectId} sessionId={sessionId} canWrite={canWrite} />
        )}
        {section === 'schedules' && (
          <SchedulesPanel
            projectId={projectId}
            sessionId={sessionId}
            canWrite={canWrite}
            creatorName={creatorName}
          />
        )}
        {section === 'watches' && (
          <StandingWatchesPanel
            projectId={projectId}
            sessionId={sessionId}
            canWrite={canWrite}
            creatorName={creatorName}
          />
        )}
        {section === 'channels' && <ChannelsPanel projectId={projectId} />}
      </div>
      <aside className="border-t border-border-default pt-4 text-sm text-fg-muted">
        <Link className={linkClass} to={`/projects/${projectId}/triggers`}>
          Open triggers and webhook audit
        </Link>
        <p className="mt-1 mb-0">
          Select a webhook trigger to inspect its Delivery history and execution history. A webhook
          receipt, event match, and agent action are separate stages; acceptance alone does not
          confirm execution.
        </p>
      </aside>
    </div>
  );
}
