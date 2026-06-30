import { Button, Input, PageLayout } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  Check,
  ChevronDown,
  Clock,
  Github,
  Info,
  Lightbulb,
  MessageSquare,
  Rocket,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { ModeButton, ProfileSetupPanel, type ProfileDraft, type SetupStatus } from '../../components/project-onboarding/shared';
import {
  DEFAULT_CONVERSATION_DRAFT,
  DEFAULT_TASK_DRAFT,
  MOCK_AGENTS,
  MOCK_BRANCHES,
  MOCK_INSTALLATIONS,
  MOCK_REPOS,
} from './mock-data';

/* ─────────────────────────── Step model ─────────────────────────── */

type StepId = 'welcome' | 'how-sam-works' | 'connect' | 'conversation' | 'task' | 'automation' | 'kickoff';

interface StepMeta {
  id: StepId;
  label: string;
  icon: typeof Github;
}

const STEPS: StepMeta[] = [
  { id: 'welcome', label: 'Welcome', icon: Rocket },
  { id: 'how-sam-works', label: 'How SAM works', icon: Box },
  { id: 'connect', label: 'Connect code', icon: Github },
  { id: 'conversation', label: 'Conversation agent', icon: MessageSquare },
  { id: 'task', label: 'Task agent', icon: Bot },
  { id: 'automation', label: 'Automation', icon: Clock },
  { id: 'kickoff', label: 'Kick off', icon: Rocket },
];

/* ─────────────────────────── Shared presentational ─────────────────────────── */

/**
 * The signature "why" disclosure, modeled on the marketing self-host page's
 * `<details class="sh-why">`: an info icon, a question, and an expand chevron
 * that reveals extra context for readers who want it.
 */
function WhyDetails({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group rounded-md border border-border-default bg-inset/60 [&_svg.why-chevron]:open:rotate-180">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-fg-secondary [&::-webkit-details-marker]:hidden">
        <Info size={16} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="flex-1">{question}</span>
        <ChevronDown size={16} className="why-chevron shrink-0 text-fg-muted transition-transform" aria-hidden="true" />
      </summary>
      <div className="grid gap-2 border-t border-border-default px-3 py-3 text-sm leading-relaxed text-fg-muted">
        {children}
      </div>
    </details>
  );
}

function Callout({ variant, children }: { variant: 'info' | 'warn'; children: ReactNode }) {
  const styles =
    variant === 'info'
      ? 'border-accent/40 bg-accent/10 text-fg-secondary'
      : 'border-warning/40 bg-warning-tint text-fg-secondary';
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm ${styles}`}>
      <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** Eyebrow + heading + lead (the "what + why" intro shared by every step). */
function StepHeader({ id, title, lead }: { id: StepId; title: string; lead: ReactNode }) {
  const index = STEPS.findIndex((s) => s.id === id);
  return (
    <div className="grid gap-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-accent">
        Step {index + 1} of {STEPS.length}
      </span>
      <h2 className="text-xl font-semibold text-fg-primary">{title}</h2>
      <p className="text-sm leading-relaxed text-fg-muted">{lead}</p>
    </div>
  );
}

/* ─────────────────────────── Progress rail ─────────────────────────── */

function ProgressRail({ current, onJump }: { current: StepId; onJump: (id: StepId) => void }) {
  const currentIndex = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="grid gap-1" aria-label="Onboarding steps">
      {STEPS.map((step, index) => {
        const state = index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'upcoming';
        const Icon = step.icon;
        return (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => onJump(step.id)}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                state === 'current'
                  ? 'bg-accent/10 text-fg-primary'
                  : 'text-fg-muted hover:bg-surface-hover'
              }`}
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs ${
                  state === 'complete'
                    ? 'border-success/50 bg-success-tint text-fg-primary'
                    : state === 'current'
                      ? 'border-accent text-fg-primary'
                      : 'border-border-default text-fg-muted'
                }`}
              >
                {state === 'complete' ? <Check size={14} aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}
              </span>
              <span className="truncate">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ─────────────────────────── Page ─────────────────────────── */

export function OnboardingPrototype() {
  const [step, setStep] = useState<StepId>('welcome');

  // Connect form (mock — no API calls)
  const [installationId, setInstallationId] = useState(MOCK_INSTALLATIONS[0]!.id);
  const [repository, setRepository] = useState(MOCK_REPOS[0]!.fullName);
  const [branch, setBranch] = useState(MOCK_BRANCHES[0]!.name);
  const [projectName, setProjectName] = useState('simple-agent-manager');
  const [description, setDescription] = useState('');

  // Profiles
  const [conversationDraft, setConversationDraft] = useState<ProfileDraft>(DEFAULT_CONVERSATION_DRAFT);
  const [taskDraft, setTaskDraft] = useState<ProfileDraft>(DEFAULT_TASK_DRAFT);
  const [conversationStatus, setConversationStatus] = useState<SetupStatus>('pending');
  const [taskStatus, setTaskStatus] = useState<SetupStatus>('pending');

  // Automation
  const [triggerName, setTriggerName] = useState('Nightly review');
  const [cronExpression, setCronExpression] = useState('0 9 * * *');
  const [triggerPrompt, setTriggerPrompt] = useState('');
  const [triggerStatus, setTriggerStatus] = useState<SetupStatus>('pending');

  // Kickoff
  const [kickoffMode, setKickoffMode] = useState<'task' | 'conversation'>('task');
  const [kickoffMessage, setKickoffMessage] = useState('');

  const currentIndex = STEPS.findIndex((s) => s.id === step);
  const progressPct = Math.round((currentIndex / (STEPS.length - 1)) * 100);

  const goNext = () => {
    const next = STEPS[Math.min(currentIndex + 1, STEPS.length - 1)]!;
    setStep(next.id);
  };
  const goBack = () => {
    const prev = STEPS[Math.max(currentIndex - 1, 0)]!;
    setStep(prev.id);
  };

  const stepBody = useMemo<ReactNode>(() => {
    switch (step) {
      case 'welcome':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="welcome"
              title="Let's create your project"
              lead="A project links one GitHub repository to the agents, conversations, tasks, and automations that work on it. We'll walk through each piece, explain why it matters, and you can skip anything you'd rather set up later."
            />
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { icon: Github, title: 'Connect code', body: 'Point SAM at a repo and branch.' },
                { icon: Bot, title: 'Add agents', body: 'Decide who does conversations and tasks.' },
                { icon: Rocket, title: 'Kick off', body: 'Start the first task or chat.' },
              ].map((card) => (
                <div key={card.title} className="grid gap-1.5 rounded-md border border-border-default bg-surface p-3">
                  <card.icon size={18} className="text-accent" aria-hidden="true" />
                  <span className="text-sm font-semibold text-fg-primary">{card.title}</span>
                  <span className="text-xs text-fg-muted">{card.body}</span>
                </div>
              ))}
            </div>
            <WhyDetails question="Why organize work into projects?">
              <p>
                Everything an agent needs lives in one place: the repo it can read and write, the
                profiles that define how it behaves, the chat history, and the tasks it has run. That
                scoping is also a security boundary — an agent in this project can't reach another
                project's code or credentials.
              </p>
            </WhyDetails>
          </div>
        );

      case 'how-sam-works':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="how-sam-works"
              title="How SAM works"
              lead="Before you configure anything, here's the one idea that makes everything else click: every conversation and every task runs in its own fresh, isolated, throwaway dev container. Agents get a full Linux box they can do anything with — but it disappears when the work ends."
            />
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                {
                  icon: Box,
                  title: 'Fresh & isolated',
                  body: 'Each run spins up its own container with your repo cloned in. Agents can install Docker, packages, anything — sandboxed away from your machine and other projects.',
                },
                {
                  icon: Trash2,
                  title: 'Ephemeral by default',
                  body: 'When the conversation or task ends, the container is torn down. Nothing inside it survives unless you deliberately persist it.',
                },
                {
                  icon: UploadCloud,
                  title: 'You decide what is kept',
                  body: 'Persistence is opt-in: tell the agent to push to a branch, upload to the SAM library, or capture results as a SAM idea.',
                },
              ].map((card) => (
                <div key={card.title} className="grid gap-1.5 rounded-md border border-border-default bg-surface p-3">
                  <card.icon size={18} className="text-accent" aria-hidden="true" />
                  <span className="text-sm font-semibold text-fg-primary">{card.title}</span>
                  <span className="text-xs text-fg-muted">{card.body}</span>
                </div>
              ))}
            </div>
            <Callout variant="warn">
              <strong className="font-semibold text-fg-primary">Workspaces are ephemeral.</strong> A task agent
              auto-pushes its branch and opens a PR when it finishes, so its work survives. A conversation agent does
              not — if it edits files or produces output and you don't tell it to push or persist that work, it's gone
              when the workspace stops.
            </Callout>
            <WhyDetails question="Where can work go so it survives?">
              <p>There are a few durable destinations:</p>
              <ul className="grid gap-1.5 pl-1">
                <li className="flex items-start gap-2">
                  <Github size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
                  <span>
                    <strong className="text-fg-secondary">Push to a branch.</strong> A finished task agent commits and
                    pushes its own branch automatically and opens a pull request for review. In a conversation, you ask
                    the agent to push when you're ready.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <UploadCloud size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
                  <span>
                    <strong className="text-fg-secondary">Upload to the SAM library.</strong> Files, artifacts, and notes
                    you want to keep outside of git.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Lightbulb size={15} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
                  <span>
                    <strong className="text-fg-secondary">Capture as a SAM idea.</strong> Turn findings or follow-up work
                    into an idea you can execute later.
                  </span>
                </li>
              </ul>
            </WhyDetails>
          </div>
        );

      case 'connect':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="connect"
              title="Connect your code"
              lead="Pick the repository and branch SAM should use when it starts work. Agents clone this repo into a fresh, isolated workspace each time they run."
            />
            <div className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
              <label htmlFor="proto-installation" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Installation</span>
                <select
                  id="proto-installation"
                  value={installationId}
                  onChange={(e) => setInstallationId(e.currentTarget.value)}
                  className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                >
                  {MOCK_INSTALLATIONS.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.accountName} ({inst.accountType})
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="proto-repo" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Repository</span>
                <select
                  id="proto-repo"
                  value={repository}
                  onChange={(e) => setRepository(e.currentTarget.value)}
                  className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                >
                  {MOCK_REPOS.map((repo) => (
                    <option key={repo.githubRepoId} value={repo.fullName}>
                      {repo.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="proto-branch" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Branch</span>
                <select
                  id="proto-branch"
                  value={branch}
                  onChange={(e) => setBranch(e.currentTarget.value)}
                  className="min-h-11 w-full rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                >
                  {MOCK_BRANCHES.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="proto-name" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Project name</span>
                <Input id="proto-name" value={projectName} onChange={(e) => setProjectName(e.currentTarget.value)} />
              </label>
              <label htmlFor="proto-description" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Description (optional)</span>
                <textarea
                  id="proto-description"
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  rows={3}
                  className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                />
              </label>
            </div>
            <WhyDetails question="Why does SAM need a GitHub App, and how is access scoped?">
              <p>
                SAM reaches your code through a GitHub App installation, not your personal token.
                Whenever an agent runs, SAM mints a short-lived token scoped to just this repository —
                so the App's permissions are the hard ceiling on what any agent can ever do here.
              </p>
              <p>
                The branch you pick is the base agents branch off of. Each run works on its own branch, so
                SAM never pushes to your default branch on its own. A finished task agent auto-pushes that
                branch and opens a PR for review; a conversation agent only pushes when you ask it to.
              </p>
            </WhyDetails>
          </div>
        );

      case 'conversation':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="conversation"
              title="Set up a conversation agent"
              lead="A conversation profile powers interactive chat — you talk to the agent, it reads and edits code live, and you stay in the loop. It's long-running and open-ended: it stays up as long as you're working with it. This is the agent you'll reach for most often."
            />
            <Callout variant="info">
              Conversation profiles default to a <strong className="font-semibold text-fg-primary">lightweight</strong>{' '}
              workspace — it skips the devcontainer build for a faster start, since interactive chat usually doesn't need
              the full environment spun up.
            </Callout>
            <ProfileSetupPanel
              title="Conversation profile"
              status={conversationStatus}
              draft={conversationDraft}
              configuredAgents={MOCK_AGENTS}
              disabled={false}
              saving={false}
              onChange={setConversationDraft}
              onSave={() => setConversationStatus('done')}
              onSkip={() => setConversationStatus('skipped')}
            />
            <WhyDetails question="What's a profile, and how does a conversation agent end?">
              <p>
                A profile bundles an agent (Claude Code, Codex, …), an optional model override, and a
                permission policy into a reusable preset. Conversation profiles are tuned for fast,
                interactive turns; task profiles are tuned to run a single job autonomously.
              </p>
              <p>
                A conversation has no built-in "done" — it's open-ended. It stays alive while you chat and
                is cleaned up after the workspace sits idle past its timeout. Remember the workspace is
                ephemeral: ask the agent to push or persist anything you want to keep before you walk away.
              </p>
            </WhyDetails>
          </div>
        );

      case 'task':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="task"
              title="Set up a task agent"
              lead="A task profile runs a single, one-off job autonomously and is expected to finish on its own. Use it for work you can hand off and review later instead of watching live."
            />
            <Callout variant="info">
              Task profiles default to a <strong className="font-semibold text-fg-primary">full</strong> workspace —
              the complete devcontainer build, so an autonomous job runs against an environment that matches your repo
              exactly with no missing tooling.
            </Callout>
            <ProfileSetupPanel
              title="Task profile"
              status={taskStatus}
              draft={taskDraft}
              configuredAgents={MOCK_AGENTS}
              disabled={false}
              saving={false}
              onChange={setTaskDraft}
              onSave={() => setTaskStatus('done')}
              onSkip={() => setTaskStatus('skipped')}
            />
            <WhyDetails question="How does a task know it's done, and what if it stalls?">
              <p>
                A task agent works on its own branch and is expected to wrap up by calling a completion
                tool when the job is finished. Because the work is isolated on a branch, it can't disrupt
                your default branch or another agent's work.
              </p>
              <p>
                If the agent goes quiet without finishing, SAM's scheduler checks in and asks whether it's
                still on track. If it doesn't respond, SAM marks the task failed and cleans up the
                workspace — so a stuck task never lingers and burns resources.
              </p>
              <p>
                The workspace is still ephemeral, but task mode persists for you: when the agent finishes, SAM
                auto-commits any pending changes, pushes the agent's branch, and opens a pull request for review.
                It pushes that branch — never your default branch. (Conversation mode does none of this; there you
                push when you decide to.)
              </p>
            </WhyDetails>
          </div>
        );

      case 'automation':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="automation"
              title="Schedule automation (optional)"
              lead="A cron trigger runs a task agent on a schedule with a prompt you define — a nightly dependency check, a morning triage, a weekly cleanup. Skip it now and add triggers later from the project page."
            />
            <section className="grid gap-3 rounded-md border border-border-default bg-surface p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label htmlFor="proto-trigger-name" className="grid gap-1.5">
                  <span className="text-sm text-fg-muted">Name</span>
                  <Input id="proto-trigger-name" value={triggerName} onChange={(e) => setTriggerName(e.currentTarget.value)} />
                </label>
                <label htmlFor="proto-cron" className="grid gap-1.5">
                  <span className="text-sm text-fg-muted">Schedule</span>
                  <Input
                    id="proto-cron"
                    value={cronExpression}
                    onChange={(e) => setCronExpression(e.currentTarget.value)}
                    placeholder="0 9 * * *"
                  />
                </label>
              </div>
              <label htmlFor="proto-trigger-prompt" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Prompt</span>
                <textarea
                  id="proto-trigger-prompt"
                  value={triggerPrompt}
                  onChange={(e) => setTriggerPrompt(e.currentTarget.value)}
                  rows={4}
                  placeholder="Review open dependency updates and open a PR for any safe bumps."
                  className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button type="button" onClick={() => setTriggerStatus('done')} disabled={triggerStatus !== 'pending'}>
                  {triggerStatus === 'done' ? 'Trigger created' : 'Create trigger'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setTriggerStatus('skipped')}
                  disabled={triggerStatus !== 'pending'}
                >
                  Skip
                </Button>
              </div>
            </section>
            <WhyDetails question="How does the schedule field work?">
              <p>
                The schedule uses standard cron syntax. <code>0 9 * * *</code> runs every day at 09:00;
                <code> 0 9 * * 1</code> runs every Monday at 09:00. Each run dispatches a task agent with the
                prompt above through the same pipeline a manual task uses.
              </p>
            </WhyDetails>
          </div>
        );

      case 'kickoff':
        return (
          <div className="grid gap-4">
            <StepHeader
              id="kickoff"
              title="Kick off your first work"
              lead="Start an initial task or conversation now, or skip and do it later from the project page. Either way, your project is ready."
            />
            <div className="grid gap-4 rounded-md border border-border-default bg-surface p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeButton
                  selected={kickoffMode === 'task'}
                  title="Task"
                  description="Agent works autonomously on a branch"
                  onClick={() => setKickoffMode('task')}
                />
                <ModeButton
                  selected={kickoffMode === 'conversation'}
                  title="Conversation"
                  description="Interactive chat with an agent"
                  onClick={() => setKickoffMode('conversation')}
                />
              </div>
              <label htmlFor="proto-kickoff" className="grid gap-1.5">
                <span className="text-sm text-fg-muted">Message</span>
                <textarea
                  id="proto-kickoff"
                  value={kickoffMessage}
                  onChange={(e) => setKickoffMessage(e.currentTarget.value)}
                  rows={4}
                  placeholder={
                    kickoffMode === 'task'
                      ? 'Add a health check endpoint and a test for it.'
                      : 'Walk me through how the auth middleware works.'
                  }
                  className="w-full resize-y rounded-md bg-inset px-3 py-2 text-sm text-fg-primary"
                />
              </label>
            </div>
            <div className="flex items-start gap-3 rounded-md border border-success/40 bg-success-tint p-4">
              <Check size={20} className="mt-0.5 shrink-0 text-fg-primary" aria-hidden="true" />
              <div className="grid gap-0.5">
                <span className="text-sm font-semibold text-fg-primary">That's everything.</span>
                <span className="text-sm text-fg-muted">
                  Start your first {kickoffMode} above, or open the project and explore.
                </span>
              </div>
            </div>
          </div>
        );
    }
  }, [
    step,
    installationId,
    repository,
    branch,
    projectName,
    description,
    conversationDraft,
    conversationStatus,
    taskDraft,
    taskStatus,
    triggerName,
    cronExpression,
    triggerPrompt,
    triggerStatus,
    kickoffMode,
    kickoffMessage,
  ]);

  return (
    <div style={{ height: '100vh', overflow: 'auto' }}>
      <PageLayout title="New Project" maxWidth="xl">
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          {/* Rail — desktop only */}
          <aside className="hidden lg:block">
            <div className="sticky top-4">
              <ProgressRail current={step} onJump={setStep} />
            </div>
          </aside>

          {/* Stage */}
          <section className="grid gap-4">
            {/* Mobile progress bar */}
            <div className="grid gap-1.5 lg:hidden">
              <div className="flex items-center justify-between text-xs text-fg-muted">
                <span>
                  Step {currentIndex + 1} of {STEPS.length}
                </span>
                <span>{STEPS[currentIndex]!.label}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
                <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            </div>

            {stepBody}

            {/* Footer nav */}
            <nav className="flex items-center justify-between gap-2 border-t border-border-default pt-4" aria-label="Step navigation">
              <Button type="button" variant="secondary" onClick={goBack} disabled={currentIndex === 0}>
                <ArrowLeft size={16} aria-hidden="true" /> Back
              </Button>
              {currentIndex < STEPS.length - 1 ? (
                <Button type="button" onClick={goNext}>
                  {step === 'welcome' ? 'Get started' : 'Continue'} <ArrowRight size={16} aria-hidden="true" />
                </Button>
              ) : (
                <Button type="button">Open project</Button>
              )}
            </nav>
          </section>
        </div>
      </PageLayout>
    </div>
  );
}

export default OnboardingPrototype;
