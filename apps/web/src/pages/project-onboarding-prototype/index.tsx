/**
 * PROTOTYPE — "Project Onboarding" (reimagined project creation)
 *
 * Self-contained, unauthed design exploration. No API calls, no auth, mock data
 * only. Route: /prototype/project-onboarding
 *
 * Premise: today's /projects/new is a flat form that drops you into an empty
 * project. This reimagines creation as a short *guided onboarding* that:
 *   1. Connect — link a GitHub repo + branch and name the project (required).
 *   2. Set up — a hand-held walkthrough that actually *creates* a lightweight
 *      conversational profile, a task profile (with PR/branch guidance + the
 *      ephemeral-workspace warning), and an optional cron trigger. Every step
 *      is skippable. (Skills are intentionally left out — still untested.)
 *   3. Kick off — an isolated, centered version of the project-chat composer
 *      (voice included) to start either a *task* or a *conversation*. Either way
 *      you land in the project, in motion — never an empty room.
 *
 * Visual language borrows from the account-level Choose-Your-Path wizard and the
 * project-chat composer (green-glow vignette, card options, dark glassy input).
 */
import { Button } from '@simple-agent-manager/ui';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Calendar,
  Check,
  ChevronRight,
  GitBranch,
  Github,
  Info,
  Lock,
  MessageSquare,
  Mic,
  Search,
  Send,
  SplitSquareVertical,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { deriveProjectName, MOCK_REPOS, type MockRepo } from './mock-data';

type Phase = 'connect' | 'setup' | 'kickoff';
type SetupStep = 'conversational' | 'task' | 'trigger';

const STEPS: { id: Phase; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'setup', label: 'Set up' },
  { id: 'kickoff', label: 'Start' },
];

const SETUP_ORDER: SetupStep[] = ['conversational', 'task', 'trigger'];

/* Agent options offered during the walkthrough. These mirror SAM's real agent
 * catalog (packages/shared/src/agents.ts — six harnesses) and model catalog
 * (packages/shared/src/model-catalog.ts). No quality/positioning claims: the
 * user already knows why they use their harness. The picker only shows the
 * agents the user has *enabled* (a credential is configured); the rest live one
 * link away in profile settings. `enabled` here is mocked for the prototype. */
interface AgentModel {
  id: string;
  name: string;
}
interface AgentOption {
  id: string;
  label: string;
  enabled: boolean;
  models: AgentModel[];
}

const AGENTS: AgentOption[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    enabled: true,
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex',
    enabled: true,
    models: [
      { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
      { id: 'o3', name: 'O3' },
    ],
  },
  {
    id: 'google-gemini',
    label: 'Gemini CLI',
    enabled: true,
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
  },
  // Available in the catalog but not configured for this mock user — surfaced
  // via the "more in settings" link rather than as selectable cards.
  {
    id: 'mistral-vibe',
    label: 'Mistral Vibe',
    enabled: false,
    models: [
      { id: 'devstral-2-2512', name: 'Devstral 2' },
      { id: 'mistral-medium-3-5-2604', name: 'Mistral Medium 3.5' },
    ],
  },
  { id: 'opencode', label: 'OpenCode', enabled: false, models: [] },
  { id: 'amp', label: 'Amp', enabled: false, models: [] },
];

const ENABLED_AGENTS = AGENTS.filter((a) => a.enabled);
const DEFAULT_AGENT = ENABLED_AGENTS[0]!;
const DISABLED_AGENT_COUNT = AGENTS.length - ENABLED_AGENTS.length;

type KickoffMode = 'task' | 'conversation';

type TriggerSchedule = 'daily' | 'weekdays' | 'weekly';

export function ProjectOnboardingPrototype() {
  const [phase, setPhase] = useState<Phase>('connect');
  const [setupStep, setSetupStep] = useState<SetupStep>('conversational');

  // Step 1 — required info
  const [query, setQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<MockRepo | null>(null);
  const [projectName, setProjectName] = useState('');
  const [branch, setBranch] = useState('');

  // Step 2 — guided setup (mock local state)
  const [convAgent, setConvAgent] = useState(DEFAULT_AGENT.id);
  const [convModel, setConvModel] = useState(DEFAULT_AGENT.models[0]!.id);
  const [taskAgent, setTaskAgent] = useState(DEFAULT_AGENT.id);
  const [taskModel, setTaskModel] = useState(DEFAULT_AGENT.models[0]!.id);
  const [taskInstructions, setTaskInstructions] = useState('');
  const [wantTrigger, setWantTrigger] = useState(false);
  const [triggerSchedule, setTriggerSchedule] = useState<TriggerSchedule>('weekdays');
  const [triggerPrompt, setTriggerPrompt] = useState('');

  // Step 3 — kickoff
  const [mode, setMode] = useState<KickoffMode>('task');
  const [kickoffText, setKickoffText] = useState('');
  const [listening, setListening] = useState(false);

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_REPOS;
    return MOCK_REPOS.filter(
      (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    );
  }, [query]);

  const stepIndex = STEPS.findIndex((s) => s.id === phase);
  const canContinueConnect =
    selectedRepo !== null && projectName.trim().length > 0 && branch.trim().length > 0;

  function selectRepo(repo: MockRepo) {
    setSelectedRepo(repo);
    setProjectName(deriveProjectName(repo.fullName));
    setBranch(repo.defaultBranch);
  }

  function selectConvAgent(id: string) {
    setConvAgent(id);
    setConvModel(AGENTS.find((a) => a.id === id)?.models[0]?.id ?? '');
  }
  function selectTaskAgent(id: string) {
    setTaskAgent(id);
    setTaskModel(AGENTS.find((a) => a.id === id)?.models[0]?.id ?? '');
  }

  function startSetup() {
    setSetupStep('conversational');
    setPhase('setup');
  }

  function advanceSetup() {
    const i = SETUP_ORDER.indexOf(setupStep);
    if (i < SETUP_ORDER.length - 1) setSetupStep(SETUP_ORDER[i + 1]!);
    else setPhase('kickoff');
  }

  function back() {
    if (phase === 'setup') {
      const i = SETUP_ORDER.indexOf(setupStep);
      if (i > 0) setSetupStep(SETUP_ORDER[i - 1]!);
      else setPhase('connect');
    } else if (phase === 'kickoff') {
      setSetupStep('trigger');
      setPhase('setup');
    }
  }

  return (
    <div
      style={{
        height: '100vh',
        overflow: 'auto',
        background: `
          radial-gradient(ellipse 60% 50% at 50% 35%, rgba(34, 197, 94, 0.12) 0%, rgba(34, 197, 94, 0.04) 40%, transparent 70%),
          radial-gradient(ellipse 100% 100% at 50% 50%, rgba(10, 14, 10, 0.0) 30%, rgba(0, 0, 0, 0.7) 100%),
          var(--bg-app, #0a0e0a)
        `,
      }}
    >
      <div className="min-h-full flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3 min-w-[64px]">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={back}
                className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer min-h-[44px] transition-colors"
              >
                <ArrowLeft size={16} /> Back
              </button>
            )}
          </div>
          <StepDots index={stepIndex} />
          <div className="flex items-center justify-end min-w-[64px]">
            <button
              type="button"
              aria-label="Exit"
              className="inline-flex items-center justify-center w-11 h-11 rounded-full text-fg-muted hover:text-fg-primary hover:bg-white/5 bg-transparent border-none cursor-pointer transition-colors"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 px-4 pb-10 sm:px-6">
          <div className="max-w-lg mx-auto pt-2 sm:pt-10">
            {phase === 'connect' && (
              <ConnectStep
                query={query}
                setQuery={setQuery}
                repos={filteredRepos}
                selectedRepo={selectedRepo}
                onSelectRepo={selectRepo}
                projectName={projectName}
                setProjectName={setProjectName}
                branch={branch}
                setBranch={setBranch}
                canContinue={canContinueConnect}
                onContinue={startSetup}
              />
            )}
            {phase === 'setup' && (
              <SetupWalkthrough
                step={setupStep}
                branch={branch}
                convAgent={convAgent}
                convModel={convModel}
                onSelectConvAgent={selectConvAgent}
                setConvModel={setConvModel}
                taskAgent={taskAgent}
                taskModel={taskModel}
                onSelectTaskAgent={selectTaskAgent}
                setTaskModel={setTaskModel}
                taskInstructions={taskInstructions}
                setTaskInstructions={setTaskInstructions}
                wantTrigger={wantTrigger}
                setWantTrigger={setWantTrigger}
                triggerSchedule={triggerSchedule}
                setTriggerSchedule={setTriggerSchedule}
                triggerPrompt={triggerPrompt}
                setTriggerPrompt={setTriggerPrompt}
                onAdvance={advanceSetup}
                onSkipAll={() => setPhase('kickoff')}
              />
            )}
            {phase === 'kickoff' && (
              <KickoffStep
                projectName={projectName}
                source={selectedRepo?.fullName ?? ''}
                branch={branch}
                mode={mode}
                setMode={setMode}
                text={kickoffText}
                setText={setKickoffText}
                listening={listening}
                onToggleListening={() => setListening((v) => !v)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── Step 1 · Connect your code ─────────────────────── */

interface ConnectStepProps {
  query: string;
  setQuery: (v: string) => void;
  repos: MockRepo[];
  selectedRepo: MockRepo | null;
  onSelectRepo: (r: MockRepo) => void;
  projectName: string;
  setProjectName: (v: string) => void;
  branch: string;
  setBranch: (v: string) => void;
  canContinue: boolean;
  onContinue: () => void;
}

function ConnectStep({
  query,
  setQuery,
  repos,
  selectedRepo,
  onSelectRepo,
  projectName,
  setProjectName,
  branch,
  setBranch,
  canContinue,
  onContinue,
}: ConnectStepProps) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent mb-2">
        New project · Step 1 of 3
      </p>
      <h1 className="sam-type-section-heading text-fg-primary mb-1">Connect your code</h1>
      <p className="sam-type-body text-fg-muted mb-6">
        A SAM project wraps one GitHub repository with chats, agents, and automation. Pick the repo
        and branch your agents will work in.
      </p>

      {/* Search */}
      <div className="relative mb-3">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your GitHub repositories"
          className="w-full rounded-lg bg-surface border border-border-default text-fg-primary text-sm pl-9 pr-3 py-2.5 outline-none focus:border-accent transition-colors"
        />
      </div>

      {/* Repo list */}
      <div className="flex flex-col gap-2 mb-6">
        {repos.length === 0 && (
          <div className="text-sm text-fg-muted text-center py-8 border border-dashed border-border-default rounded-lg">
            No repositories match &ldquo;{query}&rdquo;.
          </div>
        )}
        {repos.map((repo) => {
          const isSelected = selectedRepo?.id === repo.id;
          return (
            <button
              key={repo.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectRepo(repo)}
              className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer bg-surface ${
                isSelected ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent">
                  <Github size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-fg-primary text-sm break-words">
                      {repo.fullName}
                    </span>
                    {repo.private && <Lock size={11} className="text-fg-muted shrink-0" />}
                    {isSelected && <Check size={14} className="text-accent ml-auto shrink-0" />}
                  </div>
                  {repo.description && (
                    <p className="text-xs text-fg-muted mt-0.5 break-words">{repo.description}</p>
                  )}
                  <div className="flex items-center flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-fg-muted/80">
                    <span>{repo.language}</span>
                    <span className="inline-flex items-center gap-1">
                      <GitBranch size={10} /> {repo.defaultBranch}
                    </span>
                    <span>Updated {repo.pushedAt}</span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Required details — name + branch, revealed once a repo is chosen */}
      {selectedRepo && (
        <div className="rounded-lg border border-accent/30 bg-accent/[0.04] p-4 mb-6">
          <label className="block mb-4">
            <span className="text-sm text-fg-muted">Project name</span>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              className="w-full mt-1.5 rounded-lg bg-surface border border-border-default text-fg-primary text-sm px-3 py-2.5 outline-none focus:border-accent transition-colors"
            />
            <span className="text-[11px] text-fg-muted/70 mt-1 block">
              Pre-filled from the repo — change it if you like.
            </span>
          </label>

          <label className="block">
            <span className="text-sm text-fg-muted inline-flex items-center gap-1.5">
              <GitBranch size={12} className="text-accent" /> Working branch
            </span>
            <div className="relative mt-1.5">
              <select
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                className="w-full appearance-none rounded-lg bg-surface border border-border-default text-fg-primary text-sm pl-3 pr-9 py-2.5 outline-none focus:border-accent transition-colors cursor-pointer truncate"
              >
                {selectedRepo.branches.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === selectedRepo.defaultBranch ? ' (default)' : ''}
                  </option>
                ))}
              </select>
              <ChevronRight
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-fg-muted pointer-events-none"
              />
            </div>
            <span className="text-[11px] text-fg-muted/70 mt-1 block">
              Agents check out and work on this branch. Want to keep it protected? Set branch
              protection rules in GitHub — SAM respects whatever you define.
            </span>
          </label>
        </div>
      )}

      <Button
        type="button"
        variant="primary"
        size="lg"
        disabled={!canContinue}
        onClick={onContinue}
        className="w-full"
      >
        Continue <ArrowRight size={15} />
      </Button>
    </div>
  );
}

/* ──────────────────── Step 2 · Guided setup walkthrough ──────────────────── */

interface SetupWalkthroughProps {
  step: SetupStep;
  branch: string;
  convAgent: string;
  convModel: string;
  onSelectConvAgent: (id: string) => void;
  setConvModel: (v: string) => void;
  taskAgent: string;
  taskModel: string;
  onSelectTaskAgent: (id: string) => void;
  setTaskModel: (v: string) => void;
  taskInstructions: string;
  setTaskInstructions: (v: string) => void;
  wantTrigger: boolean;
  setWantTrigger: (v: boolean) => void;
  triggerSchedule: TriggerSchedule;
  setTriggerSchedule: (v: TriggerSchedule) => void;
  triggerPrompt: string;
  setTriggerPrompt: (v: string) => void;
  onAdvance: () => void;
  onSkipAll: () => void;
}

function SetupWalkthrough(props: SetupWalkthroughProps) {
  const { step, onAdvance, onSkipAll } = props;
  const subIndex = SETUP_ORDER.indexOf(step);

  const eyebrow =
    step === 'conversational'
      ? 'Set up · 1 of 3'
      : step === 'task'
        ? 'Set up · 2 of 3'
        : 'Set up · 3 of 3 · Optional';

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          {eyebrow}
        </p>
        <button
          type="button"
          onClick={onSkipAll}
          className="text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer transition-colors"
        >
          Skip setup →
        </button>
      </div>

      {/* Sub-progress within setup */}
      <div className="flex items-center gap-1.5 mb-5" aria-hidden="true">
        {SETUP_ORDER.map((s, i) => (
          <div
            key={s}
            className={`h-1 rounded-full flex-1 transition-all ${
              i <= subIndex ? 'bg-accent/70' : 'bg-white/10'
            }`}
          />
        ))}
      </div>

      {step === 'conversational' && <ConversationalProfileStep {...props} />}
      {step === 'task' && <TaskProfileStep {...props} />}
      {step === 'trigger' && <TriggerStep {...props} />}

      <div className="flex items-center gap-2 mt-6">
        <Button type="button" variant="primary" size="lg" onClick={onAdvance} className="flex-1">
          {step === 'trigger'
            ? props.wantTrigger
              ? 'Create trigger & finish'
              : 'Finish setup'
            : 'Continue'}{' '}
          <ArrowRight size={15} />
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onAdvance}>
          Skip
        </Button>
      </div>
    </div>
  );
}

function ConversationalProfileStep({
  convAgent,
  convModel,
  onSelectConvAgent,
  setConvModel,
}: SetupWalkthroughProps) {
  return (
    <div>
      <h1 className="sam-type-section-heading text-fg-primary mb-1 flex items-center gap-2">
        <MessageSquare size={20} className="text-accent" /> Your everyday agent
      </h1>
      <p className="sam-type-body text-fg-muted mb-5">
        A <span className="text-fg-primary">conversational profile</span> is who you chat with —
        back-and-forth, interactive. Pick an agent and model; we&apos;ll wire it up as a lightweight
        workspace in conversation mode so it&apos;s ready the moment you open the project.
      </p>

      <AgentModelPicker
        selectedAgent={convAgent}
        model={convModel}
        onSelectAgent={onSelectConvAgent}
        onChangeModel={setConvModel}
      />

      <div className="flex flex-wrap gap-2 mt-4">
        <ReadonlyChip>Lightweight workspace</ReadonlyChip>
        <ReadonlyChip>Conversation mode</ReadonlyChip>
        <ReadonlyChip>Set up for you</ReadonlyChip>
      </div>
    </div>
  );
}

function TaskProfileStep({
  branch,
  taskAgent,
  taskModel,
  onSelectTaskAgent,
  setTaskModel,
  taskInstructions,
  setTaskInstructions,
}: SetupWalkthroughProps) {
  return (
    <div>
      <h1 className="sam-type-section-heading text-fg-primary mb-1 flex items-center gap-2">
        <SplitSquareVertical size={20} className="text-accent" /> Your task runner
      </h1>
      <p className="sam-type-body text-fg-muted mb-5">
        A <span className="text-fg-primary">task profile</span> is who you hand work to. It spins up
        on its own, works autonomously, and you review the result.
      </p>

      <AgentModelPicker
        selectedAgent={taskAgent}
        model={taskModel}
        onSelectAgent={onSelectTaskAgent}
        onChangeModel={setTaskModel}
      />

      <label className="block mt-4">
        <span className="text-sm text-fg-muted">How should it finish a task?</span>
        <textarea
          value={taskInstructions}
          onChange={(e) => setTaskInstructions(e.target.value)}
          rows={4}
          placeholder={`e.g. Create a branch off ${branch || 'main'}, commit your work, and open a pull request. Always push before you finish — don't leave changes only on the VM.`}
          className="w-full mt-1.5 rounded-lg bg-surface border border-border-default text-fg-primary text-sm px-3 py-2.5 outline-none focus:border-accent transition-colors resize-none leading-relaxed placeholder:text-fg-muted/60"
        />
      </label>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 mt-4 flex items-start gap-2.5">
        <Info size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-[13px] text-fg-muted leading-relaxed">
          <span className="text-fg-primary font-medium">Workspaces are ephemeral.</span> When a task
          finishes, the VM is destroyed. If the agent doesn&apos;t push a branch or open a PR, its
          work is gone for good — so tell it here exactly how to hand work back to you.
        </p>
      </div>
    </div>
  );
}

function TriggerStep({
  taskAgent,
  wantTrigger,
  setWantTrigger,
  triggerSchedule,
  setTriggerSchedule,
  triggerPrompt,
  setTriggerPrompt,
}: SetupWalkthroughProps) {
  const taskLabel = AGENTS.find((a) => a.id === taskAgent)?.label ?? 'your task profile';
  return (
    <div>
      <h1 className="sam-type-section-heading text-fg-primary mb-1 flex items-center gap-2">
        <Calendar size={20} className="text-accent" /> Run it on a schedule
      </h1>
      <p className="sam-type-body text-fg-muted mb-5">
        Anything you want done regularly? A <span className="text-fg-primary">trigger</span> runs
        your task profile ({taskLabel}) automatically — no need to be at your desk. Totally
        optional.
      </p>

      {/* Enable toggle */}
      <div className="flex flex-col gap-2 mb-2">
        <button
          type="button"
          aria-pressed={wantTrigger}
          onClick={() => setWantTrigger(true)}
          className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer bg-surface ${
            wantTrigger ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
          }`}
        >
          <span className="font-medium text-fg-primary text-sm">Yes, set up a schedule</span>
          <p className="text-xs text-fg-muted mt-0.5">Pick a cadence and what it should do.</p>
        </button>
        <button
          type="button"
          aria-pressed={!wantTrigger}
          onClick={() => setWantTrigger(false)}
          className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer bg-surface ${
            !wantTrigger ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
          }`}
        >
          <span className="font-medium text-fg-primary text-sm">Not now</span>
          <p className="text-xs text-fg-muted mt-0.5">You can add triggers anytime later.</p>
        </button>
      </div>

      {wantTrigger && (
        <div className="rounded-lg border border-accent/30 bg-accent/[0.04] p-4 mt-3">
          <label className="block mb-4">
            <span className="text-sm text-fg-muted">How often?</span>
            <div className="relative mt-1.5">
              <select
                value={triggerSchedule}
                onChange={(e) => setTriggerSchedule(e.target.value as TriggerSchedule)}
                className="w-full appearance-none rounded-lg bg-surface border border-border-default text-fg-primary text-sm pl-3 pr-9 py-2.5 outline-none focus:border-accent transition-colors cursor-pointer"
              >
                <option value="daily">Every day at 9:00 AM</option>
                <option value="weekdays">Every weekday at 9:00 AM</option>
                <option value="weekly">Every Monday at 9:00 AM</option>
              </select>
              <ChevronRight
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-fg-muted pointer-events-none"
              />
            </div>
          </label>
          <label className="block">
            <span className="text-sm text-fg-muted">What should it do each run?</span>
            <textarea
              value={triggerPrompt}
              onChange={(e) => setTriggerPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Triage any new issues opened since yesterday and label them."
              className="w-full mt-1.5 rounded-lg bg-surface border border-border-default text-fg-primary text-sm px-3 py-2.5 outline-none focus:border-accent transition-colors resize-none leading-relaxed placeholder:text-fg-muted/60"
            />
          </label>
        </div>
      )}
    </div>
  );
}

/* Agent + model picker shared by both profile sub-steps. */
function AgentModelPicker({
  selectedAgent,
  model,
  onSelectAgent,
  onChangeModel,
}: {
  selectedAgent: string;
  model: string;
  onSelectAgent: (id: string) => void;
  onChangeModel: (v: string) => void;
}) {
  const agent = AGENTS.find((a) => a.id === selectedAgent) ?? DEFAULT_AGENT;
  return (
    <div>
      <span className="text-sm text-fg-muted block mb-1.5">Agent</span>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {ENABLED_AGENTS.map((a) => {
          const active = a.id === selectedAgent;
          return (
            <button
              key={a.id}
              type="button"
              aria-pressed={active}
              onClick={() => onSelectAgent(a.id)}
              className={`text-left p-3 rounded-lg border transition-all cursor-pointer bg-surface ${
                active ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
              }`}
            >
              <span className="inline-flex items-center gap-1.5 font-medium text-fg-primary text-sm">
                <Bot size={14} className="text-accent" /> {a.label}
                {active && <Check size={13} className="text-accent ml-auto" />}
              </span>
            </button>
          );
        })}
      </div>

      {DISABLED_AGENT_COUNT > 0 && (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline mt-2 bg-transparent border-none cursor-pointer p-0"
        >
          Using a different harness? {DISABLED_AGENT_COUNT} more available in your profile settings
          <ArrowRight size={12} />
        </button>
      )}

      <label className="block mt-3">
        <span className="text-sm text-fg-muted">Model</span>
        <div className="relative mt-1.5">
          <select
            value={model}
            onChange={(e) => onChangeModel(e.target.value)}
            className="w-full appearance-none rounded-lg bg-surface border border-border-default text-fg-primary text-sm pl-3 pr-9 py-2.5 outline-none focus:border-accent transition-colors cursor-pointer"
          >
            {agent.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <ChevronRight
            size={14}
            className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-fg-muted pointer-events-none"
          />
        </div>
      </label>
    </div>
  );
}

function ReadonlyChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-fg-muted bg-white/[0.03] border border-border-default rounded-full px-2.5 py-1">
      <Check size={11} className="text-accent" /> {children}
    </span>
  );
}

/* ──────────────────────────── Step 3 · Kick off ──────────────────────────── */

interface KickoffStepProps {
  projectName: string;
  source: string;
  branch: string;
  mode: KickoffMode;
  setMode: (m: KickoffMode) => void;
  text: string;
  setText: (v: string) => void;
  listening: boolean;
  onToggleListening: () => void;
}

function KickoffStep({
  projectName,
  source,
  branch,
  mode,
  setMode,
  text,
  setText,
  listening,
  onToggleListening,
}: KickoffStepProps) {
  const placeholder =
    mode === 'task'
      ? 'Describe exactly what you want your agent to do. It runs autonomously on a fresh VM and opens a PR when it’s done…'
      : "Say hi, or describe what you're thinking about. We'll figure it out together…";
  const canSend = text.trim().length > 0;

  return (
    <div className="pt-2 sm:pt-6">
      {/* Project context */}
      <div className="text-center mb-6">
        <div className="w-14 h-14 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-3">
          <Check size={28} className="text-success" />
        </div>
        <h1 className="sam-type-section-heading text-fg-primary mb-1">
          {projectName.trim() || 'Your project'} is ready
        </h1>
        <p className="text-sm text-fg-muted">
          Linked to <span className="text-fg-primary">{source}</span>
          {branch && (
            <>
              {' '}
              on{' '}
              <span className="inline-flex items-center gap-1 text-fg-primary align-middle">
                <GitBranch size={11} className="text-accent" />
                {branch}
              </span>
            </>
          )}
          . What should we do first?
        </p>
      </div>

      {/* Mode toggle */}
      <div
        className="flex items-center gap-1 p-1 rounded-xl border border-border-default bg-surface mb-3"
        role="group"
        aria-label="How to start"
      >
        <ModeTab
          active={mode === 'task'}
          onClick={() => setMode('task')}
          icon={<SplitSquareVertical size={15} />}
          label="Hand off a task"
        />
        <ModeTab
          active={mode === 'conversation'}
          onClick={() => setMode('conversation')}
          icon={<MessageSquare size={15} />}
          label="Start a conversation"
        />
      </div>

      {/* Isolated composer — the project-chat input, lifted to center stage */}
      <div className="rounded-2xl border border-[rgba(34,197,94,0.18)] bg-[rgba(10,15,13,0.6)] p-3 shadow-[0_0_40px_rgba(22,163,74,0.08)]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          rows={4}
          className="w-full bg-transparent border-none text-fg-primary text-base outline-none resize-none leading-relaxed placeholder:text-fg-muted/60 min-h-[96px]"
        />
        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[rgba(34,197,94,0.1)]">
          <span className="text-[11px] text-fg-muted/70 truncate">
            {mode === 'task'
              ? 'Runs autonomously, then opens a PR'
              : 'Opens an interactive chat session'}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onToggleListening}
              aria-pressed={listening}
              aria-label="Voice input"
              className={`p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border transition-all cursor-pointer ${
                listening
                  ? 'border-accent text-accent bg-accent/10 animate-pulse'
                  : 'border-[rgba(34,197,94,0.15)] text-fg-muted hover:text-fg-primary hover:border-[rgba(34,197,94,0.3)]'
              }`}
            >
              <Mic size={18} />
            </button>
            <button
              type="button"
              disabled={!canSend}
              className={`px-4 py-2 min-h-[44px] inline-flex items-center gap-2 rounded-lg text-sm font-medium transition-all ${
                canSend
                  ? 'bg-[linear-gradient(135deg,var(--sam-color-accent-primary,#16a34a),#22c55e)] text-white cursor-pointer shadow-[0_0_16px_rgba(22,163,74,0.3)] hover:shadow-[0_0_24px_rgba(22,163,74,0.4)]'
                  : 'bg-inset text-fg-muted opacity-50 cursor-default'
              }`}
            >
              {mode === 'task' ? 'Launch' : 'Send'} <Send size={15} />
            </button>
          </div>
        </div>
      </div>

      <p className="text-center text-xs text-fg-muted/70 mt-4">
        Either way you land inside {projectName.trim() || 'your project'}.{' '}
        <button
          type="button"
          className="text-fg-muted hover:text-fg-primary underline underline-offset-2 bg-transparent border-none cursor-pointer p-0"
        >
          Skip — just open the project
        </button>
      </p>
    </div>
  );
}

function ModeTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-[40px] px-2 rounded-lg text-xs sm:text-sm font-medium transition-all cursor-pointer ${
        active
          ? 'bg-accent/15 text-accent ring-1 ring-accent/40'
          : 'text-fg-muted hover:text-fg-primary'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

/* ──────────────────────────────── Bits ──────────────────────────────────── */

function StepDots({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-2" aria-hidden="true">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center gap-2">
          <div
            className={`h-1.5 rounded-full transition-all ${
              i === index ? 'w-6 bg-accent' : i < index ? 'w-1.5 bg-accent/60' : 'w-1.5 bg-white/15'
            }`}
          />
        </div>
      ))}
    </div>
  );
}
