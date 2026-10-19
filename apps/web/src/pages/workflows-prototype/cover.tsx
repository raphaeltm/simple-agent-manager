/**
 * PROTOTYPE ONLY — index of every screen in the Workflows exploration.
 */
import { ArrowRight, Bookmark, FlaskConical, Map, Play, Sparkles, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { p } from './shell';

const WALK: { to: string; title: string; note: string }[] = [
  {
    to: 'b/chat?t=flags-1',
    title: 'Your agent starts a one-off run from chat',
    note: 'No approval screen — it starts like dispatching tasks. The card updates live.',
  },
  {
    to: 'b/workflows/runs/run-flags?t=flags-1',
    title: 'Parallel work, capped at 2 at once',
    note: 'Four evaluations; two wait for a free slot.',
  },
  {
    to: 'b/workflows/runs/run-flags?t=flags-3',
    title: 'A step fails — the run needs attention',
    note: 'Only the dependent step is blocked; the rest keep going.',
  },
  {
    to: 'b/workflows/runs/run-flags?t=flags-3&step=growthbook',
    title: 'Retry with changes, or skip',
    note: 'Agent-reported failures never auto-retry; you decide.',
  },
  {
    to: 'b/chat?t=flags-6',
    title: 'Your agent wakes up with the result',
    note: 'SAM wakes the agent that started the run when it finishes.',
  },
  {
    to: 'b/workflows/runs/run-flags?t=flags-6&dialog=save',
    title: 'Save the one-off as a workflow',
    note: 'Pick which parts become blanks you fill in next time.',
  },
  {
    to: 'b/workflows',
    title: 'Workflows › Runs',
    note: 'What needs you first, then what’s running, then finished.',
  },
  {
    to: 'b/workflows/saved',
    title: 'Workflows › Saved',
    note: 'Dashed recipe cards: the reusable thing, never a status.',
  },
  {
    to: 'b/workflows/saved/code-change',
    title: 'A saved workflow',
    note: 'Blueprint, blanks, schedule (a normal cron trigger), runs, versions.',
  },
  {
    to: 'b/workflows/saved/code-change/start',
    title: 'Start a run of it yourself',
    note: 'Fill the blanks and start. Nothing else to approve.',
  },
  {
    to: 'b/workflows/runs/run-csv?t=csv-2',
    title: 'Code change: review and tests in parallel',
    note: 'Recipe-style groups: First / Then · at the same time / Finally.',
  },
  {
    to: 'b/workflows/runs/run-csv?t=csv-3&view=graph',
    title: 'Graph view (desktop)',
    note: 'Same run as a left-to-right graph; particles show what’s moving.',
  },
  {
    to: 'b/workflows/runs/run-csv?t=csv-5&step=approve',
    title: 'An approval step inside the workflow',
    note: 'Evidence from earlier steps, then Approve or Reject. Agents can’t approve.',
  },
  {
    to: 'b/step-chat',
    title: 'A step’s own chat',
    note: 'Flat in the chat list with “Step 2 of 7”, and a link back to the run.',
  },
  {
    to: 'b/workflows/runs/run-csv?t=csv-2&dialog=cancel',
    title: 'Cancel a run',
    note: 'Steps push their work, then stop. Shown as cancelled, not failed.',
  },
  {
    to: 'b/new-chat',
    title: 'New chat offers saved workflows',
    note: 'Next to the starter prompts — no new nav needed to start one.',
  },
  {
    to: 'b/workflows/runs/run-stress',
    title: 'Stress test: 25 steps, long names',
    note: 'Wrapping, many parallel steps, a failure and a blocked step.',
  },
];

function OptionCard({
  letter,
  title,
  tagline,
  recommended,
  links,
}: {
  letter: string;
  title: string;
  tagline: string;
  recommended?: boolean;
  links: { to: string; label: string }[];
}) {
  return (
    <div
      className="rounded-lg border p-4 flex flex-col gap-2 min-w-0"
      style={{
        borderColor: recommended
          ? 'var(--sam-color-accent-primary)'
          : 'var(--sam-color-border-default)',
        background: recommended
          ? 'color-mix(in srgb, var(--sam-color-accent-primary) 7%, var(--sam-color-bg-surface))'
          : 'var(--sam-color-bg-surface)',
      }}
    >
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-md flex items-center justify-center text-sm font-bold bg-inset border border-border-default">
          {letter}
        </span>
        <span className="text-sm font-semibold text-fg-primary flex-1">{title}</span>
        {recommended && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent text-fg-on-accent">
            Recommended
          </span>
        )}
      </div>
      <p className="m-0 text-xs text-fg-muted leading-relaxed">{tagline}</p>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {links.map((l) => (
          <Link
            key={l.to}
            to={p(l.to)}
            className="text-xs text-accent inline-flex items-center gap-1"
          >
            {l.label} <ArrowRight size={11} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Term({ icon, word, children }: { icon: ReactNode; word: string; children: ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start">
      <span className="shrink-0 mt-0.5 text-fg-muted">{icon}</span>
      <div className="text-xs leading-relaxed">
        <span className="font-semibold text-fg-primary">{word}</span>{' '}
        <span className="text-fg-muted">— {children}</span>
      </div>
    </div>
  );
}

export function Cover() {
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} data-testid="prototype-cover">
      <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8 flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <span
            className="self-start inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wide px-2.5 py-1 rounded-full"
            style={{
              background: 'var(--sam-color-warning-tint)',
              color: 'var(--sam-color-warning-fg)',
            }}
          >
            <FlaskConical size={12} /> PROTOTYPE · design exploration · synthetic data
          </span>
          <h1 className="m-0 text-2xl sm:text-3xl font-bold text-fg-primary">Workflows in SAM</h1>
          <p className="m-0 text-sm text-fg-muted leading-relaxed max-w-3xl">
            Agent work in steps you can follow: a reusable{' '}
            <b className="text-fg-primary">saved workflow</b>, or a{' '}
            <b className="text-fg-primary">one-off run</b> that you or an agent makes up on the
            spot. Each step is an ordinary task. SAM starts the next one when the ones before it
            finish. Single-user: you own and control your workflows. Nothing here is wired to SAM.
          </p>
        </header>

        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Three ways to organize it
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            <OptionCard
              letter="A"
              title="Runs live in Chat"
              tagline="No new area. A run is a row in the chat list; saved workflows start from the composer and are managed under Ideas."
              links={[
                { to: 'a/chat', label: 'Chat with a run' },
                { to: 'a/plans', label: 'Ideas › Plans' },
              ]}
            />
            <OptionCard
              letter="B"
              recommended
              title="A Workflows area, entered from Chat"
              tagline="One project nav item with Runs and Saved. Runs also appear as cards in the chat that started them; step chats stay flat with a link back."
              links={[
                { to: 'b/chat?t=flags-1', label: 'Start from chat' },
                { to: 'b/workflows', label: 'Workflows' },
                { to: 'b/workflows/runs/run-csv', label: 'A run' },
              ]}
            />
            <OptionCard
              letter="C"
              title="Runbooks and run timelines"
              tagline="Saved workflows are runnable documents in the Library; each run is a timeline you read like a chat. Home shows runs across projects."
              links={[
                { to: 'c/run', label: 'Run timeline' },
                { to: 'c/runbook', label: 'Runbook' },
                { to: 'c/home', label: 'Home' },
              ]}
            />
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            Walk the recommended flow (B)
          </h2>
          <ol className="list-none m-0 p-0 grid gap-2 md:grid-cols-2">
            {WALK.map((w, i) => (
              <li key={w.to}>
                <Link
                  to={p(w.to)}
                  className="flex gap-3 rounded-md border border-border-default px-3 py-2.5 no-underline hover:border-accent/50 bg-[var(--sam-glass-nested-bg)] h-full"
                >
                  <span className="shrink-0 w-6 h-6 rounded-full bg-inset border border-border-default text-[11px] flex items-center justify-center tabular-nums text-fg-muted">
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm text-fg-primary">{w.title}</span>
                    <span className="block text-[11px] text-fg-muted leading-relaxed">
                      {w.note}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-3">
            <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Diagrams
            </h2>
            {[
              ['diagrams/model', 'What’s what: saved workflow, run, step, chat'],
              ['diagrams/sitemap', 'Where things live in A, B and C'],
              ['diagrams/flows', 'How runs start and how people move between them'],
              ['diagrams/states', 'Step and run states, in plain words'],
            ].map(([to, label]) => (
              <Link
                key={to}
                to={p(to ?? '')}
                className="inline-flex items-center gap-2 text-sm text-accent"
              >
                <Map size={14} /> {label}
              </Link>
            ))}
          </div>
          <div className="flex flex-col gap-2.5">
            <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
              Words used on screen
            </h2>
            <Term icon={<Bookmark size={14} />} word="Saved workflow">
              a reusable list of steps, with blanks you fill in each time. Drawn dashed, never shows
              a status.
            </Term>
            <Term icon={<Play size={14} />} word="Run">
              one time a workflow is carried out. Solid and colored by progress.
            </Term>
            <Term icon={<Sparkles size={14} />} word="One-off run">
              a run made up on the spot by you or an agent. Can be saved as a workflow afterwards.
            </Term>
            <Term icon={<Workflow size={14} />} word="Step">
              one item of a run: an agent chat, or an approval only you can give.
            </Term>
          </div>
        </section>
      </div>
    </div>
  );
}
