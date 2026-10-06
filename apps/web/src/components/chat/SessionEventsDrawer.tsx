import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ExternalLink, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';

import { useQueryScope } from '../../hooks/useQueryScope';
import { getProjectMembers } from '../../lib/api';
import { SchedulesPanel } from '../project-events/SchedulesPanel';
import { StandingWatchesPanel } from '../project-events/StandingWatchesPanel';
import { SubscriptionsPanel } from '../project-events/SubscriptionsPanel';
import { useDialogFocusTrap } from './useDialogFocusTrap';

type EventsTab = 'subscriptions' | 'schedules' | 'watches';

const TABS: readonly { id: EventsTab; label: string }[] = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'watches', label: 'Watches' },
];

interface SessionEventsDrawerProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
}

export function SessionEventsDrawer({ projectId, sessionId, onClose }: SessionEventsDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(panelRef, onClose);
  const [activeTab, setActiveTab] = useState<EventsTab>('subscriptions');

  const scope = useQueryScope();
  const members = useQuery({
    queryKey: ['auth', scope, 'events', projectId, 'members'],
    queryFn: () => getProjectMembers(projectId),
    enabled: Boolean(scope),
  });
  const canWrite = members.data?.members.some(
    (item) =>
      item.userId === scope && (item.role === 'owner' || (item.status === 'active' && item.role !== 'viewer'))
  ) ?? false;

  const creatorName = useCallback(
    (id: string) => {
      const creator = members.data?.members.find((item) => item.userId === id);
      return creator?.user?.name || (id === scope ? 'You' : id);
    },
    [members.data?.members, scope]
  );

  const fullPageUrl = `/projects/${projectId}/events?sessionId=${encodeURIComponent(sessionId)}`;

  return createPortal(
    <>
      <div
        className="hidden md:block fixed inset-0 glass-backdrop-dim z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className="glass-panel-container glass-composited fixed z-50 glass-modal rounded-l-[20px] rounded-r-none border-y-0 border-r-0 flex flex-col shadow-xl overflow-hidden
          inset-0
          md:inset-y-0 md:left-auto md:right-0 md:w-[440px] lg:w-[520px]
          before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:w-[3px] before:bg-[linear-gradient(to_bottom,transparent_0%,rgba(34,197,94,0.55)_50%,transparent_100%)] before:pointer-events-none before:blur-[1px]"
        role="dialog"
        aria-modal="true"
        aria-label="Session events"
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-border-default shrink-0 min-h-[44px]">
          <CalendarClock size={16} className="text-fg-muted shrink-0" />
          <h2 className="text-sm font-medium text-fg-primary flex-1 min-w-0">Events</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-bg-hover text-fg-muted hover:text-fg-primary transition-colors"
            aria-label="Close events"
          >
            <X size={16} />
          </button>
        </header>

        <nav className="flex border-b border-border-default shrink-0" aria-label="Events tabs">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-3 py-2 text-xs font-medium transition-colors cursor-pointer border-b-2 ${
                activeTab === tab.id
                  ? 'border-accent-primary text-fg-primary'
                  : 'border-transparent text-fg-muted hover:text-fg-primary hover:bg-bg-hover'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          {activeTab === 'subscriptions' && (
            <SubscriptionsPanel projectId={projectId} sessionId={sessionId} canWrite={canWrite} />
          )}
          {activeTab === 'schedules' && (
            <SchedulesPanel
              projectId={projectId}
              sessionId={sessionId}
              canWrite={canWrite}
              creatorName={creatorName}
            />
          )}
          {activeTab === 'watches' && (
            <StandingWatchesPanel
              projectId={projectId}
              sessionId={sessionId}
              canWrite={canWrite}
              creatorName={creatorName}
            />
          )}
        </div>

        <footer className="shrink-0 border-t border-border-default px-3 py-2">
          <Link
            to={fullPageUrl}
            className="inline-flex items-center gap-1 text-xs text-accent no-underline hover:underline"
          >
            <ExternalLink size={12} />
            View full page
          </Link>
        </footer>
      </div>
    </>,
    document.body
  );
}
