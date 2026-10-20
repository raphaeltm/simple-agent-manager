import { Button } from '@simple-agent-manager/ui';
import { Plus, Workflow } from 'lucide-react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { Page } from './frame';
import { TEMPLATES } from './mock-activity';
import type { Nav } from './nav';
import { KindIcon, PageHeader, Panel, SectionTitle } from './ui';

/** First visit to a project with no automation yet. */
export function EmptyAutomation({ nav }: { nav: Nav }) {
  const isMobile = useIsMobile();
  return (
    <Page>
      <PageHeader
        title="Automation"
        subtitle="Work that starts on its own: on a schedule, or when something happens."
      />
      <Panel className="flex flex-col items-center gap-4 px-6 py-10 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sam-color-accent-primary-tint)] text-accent">
          <Workflow size={26} aria-hidden />
        </span>
        <div className="flex max-w-md flex-col gap-2">
          <h2 className="m-0 text-[19px] font-semibold text-fg-primary">
            Nothing runs on its own yet
          </h2>
          <p className="m-0 text-[15px] text-fg-muted">
            Automations start chats for you — every morning, when someone opens an issue, or when
            your CI reports a failed deploy. You can read, reply to or stop every chat they start.
          </p>
        </div>
        <Button onClick={() => nav.create('when')}>
          <Plus size={18} aria-hidden /> New automation
        </Button>
      </Panel>
      <div className="flex flex-col gap-3">
        <SectionTitle title="Or start from an example" />
        <div className={`grid gap-3 ${isMobile ? 'grid-cols-1' : 'grid-cols-3'}`}>
          {TEMPLATES.map((t) => (
            <Panel key={t.title} className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <KindIcon kind={t.kind} />
                <span className="text-[15px] font-semibold text-fg-primary">{t.title}</span>
              </div>
              <p className="m-0 flex-1 text-sm text-fg-muted">{t.text}</p>
              <Button variant="ghost" onClick={() => nav.create('schedule')}>
                Use this
              </Button>
            </Panel>
          ))}
        </div>
      </div>
      <p className="m-0 text-[13px] text-fg-muted">
        Agents can also set these up for you — ask in any chat, e.g. “every weekday at 9, summarize
        open PRs”.
      </p>
    </Page>
  );
}
