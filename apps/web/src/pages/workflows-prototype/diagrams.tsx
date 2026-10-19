/**
 * PROTOTYPE ONLY — explanatory diagrams. "What's what" and the state legend are
 * hand-built so they read at a glance; flows and the screen map are Mermaid
 * rendered through the REAL RenderedMarkdown, i.e. exactly as the same source
 * renders in SAM's Library viewer.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Bot,
  CalendarClock,
  Hand,
  MessageSquare,
  Play,
  Sparkles,
  User2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { DiagramFlows, DiagramSitemap } from './diagrams-maps';
import { CSV_RUN } from './mock-runs-code-change';
import { getSaved } from './mock-workflows';
import { frameAt, type StepStatus } from './model';
import { BASE, p, PrototypeStrip } from './shell';
import { RUN_META, RunStatusPill, STEP_META, StepIcon, StepProgressBar } from './status-ui';
import { ShapeStrip } from './workflow-cards';

export function DiagramPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const tabs = [
    ['model', 'What’s what'],
    ['sitemap', 'Where things live'],
    ['flows', 'How runs start and move'],
    ['states', 'States'],
  ];
  return (
    <div className="flex flex-col h-full">
      <PrototypeStrip label="Diagrams" />
      <div className="flex-1 min-h-0 overflow-auto" data-scroll-target>
        <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
          <nav className="flex flex-wrap gap-1.5" aria-label="Diagrams">
            <Link to={BASE} className="text-xs text-fg-muted mr-2 self-center">
              ← All screens
            </Link>
            {tabs.map(([k, label]) => (
              <Link
                key={k}
                to={p(`diagrams/${k}`)}
                className="text-xs rounded-full border border-border-default px-2.5 py-1 no-underline text-fg-muted hover:text-fg-primary"
              >
                {label}
              </Link>
            ))}
          </nav>
          <header>
            <h1 className="m-0 text-xl sm:text-2xl font-bold text-fg-primary">{title}</h1>
            <p className="m-0 mt-1 text-sm text-fg-muted max-w-3xl leading-relaxed">{subtitle}</p>
          </header>
          {children}
        </div>
      </div>
    </div>
  );
}

function Arrow({ label, dir = 'right' }: { label?: string; dir?: 'right' | 'left' | 'down' }) {
  const isMobile = useIsMobile();
  const d = isMobile && dir !== 'down' ? 'down' : dir;
  const Icon = d === 'down' ? ArrowDown : d === 'left' ? ArrowLeft : ArrowRight;
  return (
    <div
      className={`flex ${d === 'down' ? 'flex-col py-1' : 'flex-col px-1'} items-center justify-center gap-1 shrink-0 text-center`}
    >
      {label && (
        <span className="text-[11px] text-fg-muted leading-tight max-w-[150px]">{label}</span>
      )}
      <Icon size={18} style={{ color: 'var(--sam-color-accent-primary)' }} aria-hidden />
    </div>
  );
}

function Box({
  kind,
  title,
  children,
}: {
  kind: 'saved' | 'run' | 'oneoff' | 'work';
  title: ReactNode;
  children: ReactNode;
}) {
  const styles: Record<string, React.CSSProperties> = {
    saved: {
      border: '1.5px dashed color-mix(in srgb, var(--sam-color-fg-muted) 60%, transparent)',
      background: 'transparent',
    },
    run: {
      border: '1.5px solid color-mix(in srgb, var(--sam-color-success) 55%, transparent)',
      background: 'var(--sam-color-bg-surface)',
    },
    oneoff: {
      border: '1.5px solid color-mix(in srgb, var(--sam-color-info) 55%, transparent)',
      background: 'var(--sam-color-bg-surface)',
    },
    work: {
      border: '1px solid var(--sam-color-border-default)',
      background: 'var(--sam-color-bg-inset)',
    },
  };
  return (
    <div className="rounded-lg p-3 flex flex-col gap-2 min-w-0 flex-1" style={styles[kind]}>
      <div className="text-sm font-semibold text-fg-primary flex items-center gap-1.5">{title}</div>
      {children}
    </div>
  );
}

function ModelDiagram() {
  const isMobile = useIsMobile();
  const wf = getSaved('code-change');
  const frame = frameAt(CSV_RUN, null);
  const row = isMobile ? 'flex flex-col' : 'flex items-stretch';
  return (
    <div className="flex flex-col gap-2">
      <div className={row}>
        <Box
          kind="saved"
          title={
            <>
              <Bookmark size={15} /> Saved workflow
            </>
          }
        >
          <div className="text-xs text-fg-primary">“{wf.name}”</div>
          <ShapeStrip steps={wf.steps} />
          <ul className="m-0 pl-4 text-[11px] text-fg-muted leading-relaxed">
            <li>The reusable list of steps, with blanks to fill in.</li>
            <li>Versions v1 → v3. Editing makes v4.</li>
            <li>Dashed, never shows progress.</li>
          </ul>
        </Box>
        <Arrow label="Start · by you, your agent, or a schedule" />
        <Box
          kind="run"
          title={
            <>
              <Play size={15} /> Run #14
            </>
          }
        >
          <div className="text-xs text-fg-primary">“{CSV_RUN.title}”</div>
          <StepProgressBar steps={CSV_RUN.steps} frame={frame} />
          <div className="flex items-center gap-2">
            <RunStatusPill status={frame.status} />
            <span className="text-[11px] text-fg-muted">5 of 7 done</span>
          </div>
          <ul className="m-0 pl-4 text-[11px] text-fg-muted leading-relaxed">
            <li>One time it ran. Keeps a frozen copy of v3.</li>
            <li>Solid and colored by progress.</li>
          </ul>
        </Box>
        <Arrow label="Each step, when its turn comes, becomes" />
        <Box
          kind="work"
          title={
            <>
              <MessageSquare size={15} /> What does the work
            </>
          }
        >
          <div className="flex items-center gap-2 text-xs text-fg-primary">
            <Bot size={13} className="text-fg-muted" /> 6 agent steps → 6 ordinary task chats
          </div>
          <div
            className="flex items-center gap-2 text-xs"
            style={{ color: 'var(--sam-color-warning-fg)' }}
          >
            <Hand size={13} /> 1 approval step → a decision only you make
          </div>
          <ul className="m-0 pl-4 text-[11px] text-fg-muted leading-relaxed">
            <li>Chats show in Chat as “Step 3 of 7”, flat.</li>
            <li>Same profiles, sleep/wake and recovery as any task.</li>
          </ul>
        </Box>
      </div>
      <div className={isMobile ? 'flex flex-col' : 'flex items-stretch'}>
        <div className="flex-1 flex items-center justify-end">
          {!isMobile && (
            <Arrow dir="left" label="Save as workflow — when a one-off is worth repeating" />
          )}
        </div>
        <Box
          kind="oneoff"
          title={
            <>
              <Sparkles size={15} /> One-off run
            </>
          }
        >
          <div className="text-xs text-fg-primary">“Research: choosing a feature-flag service”</div>
          <ul className="m-0 pl-4 text-[11px] text-fg-muted leading-relaxed">
            <li>A run with no saved workflow behind it.</li>
            <li>Made up on the spot by you, or by your agent in chat — it just starts.</li>
          </ul>
        </Box>
        {isMobile && <Arrow dir="down" label="Save as workflow — when it’s worth repeating" />}
        <div className="flex-1" />
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
        {[
          [
            <User2 key="u" size={14} />,
            'Single-user',
            'Your workflows, your runs, your approvals. Starting one needs no extra approval — it’s like dispatching a task.',
          ],
          [
            <CalendarClock key="c" size={14} />,
            'Schedules are triggers',
            'A schedule is an ordinary cron trigger whose action is “start this workflow”.',
          ],
          [
            <Hand key="h" size={14} />,
            'Approval is a step',
            'Only where a workflow asks for it, e.g. before merge. Never to start a run.',
          ],
        ].map(([icon, h, body]) => (
          <div
            key={h as string}
            className="rounded-md border border-border-default px-3 py-2 flex gap-2"
          >
            <span className="text-fg-muted shrink-0 mt-0.5">{icon}</span>
            <span>
              <span className="block font-semibold text-fg-primary">{h}</span>
              <span className="text-fg-muted leading-relaxed">{body}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STEP_WHEN: Record<StepStatus, string> = {
  waiting: 'Earlier steps haven’t finished. Shows which ones.',
  up_next: 'Ready, held for a free slot (limit per run) or a machine.',
  starting: 'Getting a machine or container ready.',
  running: 'Its agent chat is working.',
  done: 'Finished and reported a result (PR, summary, file).',
  failed: 'The agent couldn’t finish. Machine problems retry once on their own.',
  blocked: 'Waits on a step that failed or was rejected. Not a failure itself.',
  needs_you: 'An approval step is asking you.',
  approved: 'You approved; the next steps start.',
  rejected: 'You declined; the run needs attention.',
  skipped: 'You chose to go on without it.',
  cancelled: 'You stopped the run. Work was pushed first. Not a failure.',
};

function StatesDiagram() {
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h2 className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Step
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(STEP_META) as StepStatus[]).map((k) => (
            <div
              key={k}
              className="rounded-md border border-border-default px-3 py-2 flex gap-2.5 items-start"
            >
              <StepIcon status={k} size={16} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold" style={{ color: STEP_META[k].color }}>
                  {STEP_META[k].label}
                </span>
                <span className="block text-xs text-fg-muted leading-relaxed">{STEP_WHEN[k]}</span>
              </span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          Run
        </h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(RUN_META) as (keyof typeof RUN_META)[]).map((k) => (
            <div
              key={k}
              className="rounded-md border border-border-default px-3 py-2 flex flex-col gap-1"
            >
              <RunStatusPill status={k} />
              <span className="text-xs text-fg-muted leading-relaxed">
                {
                  {
                    draft: 'Only when you asked to see the plan first. Nothing started.',
                    running: 'Steps are being started as their turn comes.',
                    needs_you: 'An approval step is waiting for you.',
                    needs_attention:
                      'Something failed or was rejected; what doesn’t depend on it continues.',
                    paused: 'No new steps start; running ones finish.',
                    done: 'Every step done (or skipped on purpose).',
                    cancelled: 'You stopped it. Not a failure.',
                  }[k]
                }
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default function Diagrams() {
  const { name } = useParams();
  if (name === 'sitemap') {
    return (
      <DiagramPage
        title="Where things live"
        subtitle="Three ways to organize saved workflows, runs and step chats inside a project. Green = new or changed; everything else exists today."
      >
        <DiagramSitemap />
      </DiagramPage>
    );
  }
  if (name === 'flows') {
    return (
      <DiagramPage
        title="How runs start, and how you move between them"
        subtitle="Rendered by SAM’s own Mermaid renderer, so the same source looks the same in the Library."
      >
        <DiagramFlows />
      </DiagramPage>
    );
  }
  if (name === 'states') {
    return (
      <DiagramPage
        title="States, in plain words"
        subtitle="Amber is reserved for “waiting for you”. Red means something went wrong; cancelled and skipped are grey on purpose."
      >
        <StatesDiagram />
      </DiagramPage>
    );
  }
  return (
    <DiagramPage
      title="What’s what"
      subtitle="A saved workflow is the recipe; a run is one time it was cooked; each step does its work in an ordinary chat."
    >
      <ModelDiagram />
    </DiagramPage>
  );
}
