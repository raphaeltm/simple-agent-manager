/**
 * PROTOTYPE — "Project Onboarding" (reimagined project creation)
 *
 * Self-contained, unauthed design exploration. No API calls, no auth, mock data
 * only. Route: /prototype/project-onboarding
 *
 * Premise: today's /projects/new is a flat form that drops you into an empty
 * project. This reimagines creation as a short *guided onboarding* that (1)
 * connects your code, (2) establishes intent — what you want to do first — and
 * (3) lands you in motion instead of an empty room. Visual language borrows from
 * the account-level Choose-Your-Path wizard (card options, green-glow vignette,
 * progress, accessible focus model).
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Compass,
  GitBranch,
  Github,
  ListChecks,
  Lock,
  MessageSquare,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { deriveProjectName, MOCK_REPOS,type MockRepo } from './mock-data';

type Phase = 'source' | 'intent' | 'ready';

type IntentId = 'chat' | 'task' | 'explore' | 'setup';

interface IntentOption {
  id: IntentId;
  label: string;
  description: string;
  icon: ReactNode;
  /** Where this intent lands the user after the project is created. */
  landing: string;
  /** Shown as a small chip to teach the profile boundary without overwhelming. */
  profileHint?: string;
}

const INTENT_OPTIONS: IntentOption[] = [
  {
    id: 'chat',
    label: 'Just start chatting',
    description: 'Open a fresh conversation and describe what you want — the agent takes it from there.',
    icon: <MessageSquare size={18} />,
    landing: 'Opens a new chat in your project',
    profileHint: 'Default conversational profile',
  },
  {
    id: 'task',
    label: 'Hand off a task',
    description: 'Write one task and the agent runs it autonomously on a fresh VM, then opens a PR.',
    icon: <ListChecks size={18} />,
    landing: 'Opens the task composer, pre-filled',
    profileHint: 'Default conversational profile',
  },
  {
    id: 'explore',
    label: 'Explore the codebase',
    description: "Start with the agent already oriented — it reads the repo and summarizes how it's built.",
    icon: <Compass size={18} />,
    landing: 'Opens a chat seeded with an explore prompt',
  },
  {
    id: 'setup',
    label: "I'll set it up myself",
    description: 'Skip ahead to the project home and configure profiles, triggers, and skills first.',
    icon: <Settings2 size={18} />,
    landing: 'Lands on the project home',
  },
];

const STEPS: { id: Phase; label: string }[] = [
  { id: 'source', label: 'Code' },
  { id: 'intent', label: 'First move' },
  { id: 'ready', label: 'Ready' },
];

export function ProjectOnboardingPrototype() {
  const [phase, setPhase] = useState<Phase>('source');
  const [query, setQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<MockRepo | null>(null);
  const [samGit, setSamGit] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [intent, setIntent] = useState<IntentId | null>(null);

  const filteredRepos = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return MOCK_REPOS;
    return MOCK_REPOS.filter(
      (r) => r.fullName.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
    );
  }, [query]);

  const stepIndex = STEPS.findIndex((s) => s.id === phase);
  const canContinueSource = (selectedRepo !== null || samGit) && projectName.trim().length > 0;

  function selectRepo(repo: MockRepo) {
    setSelectedRepo(repo);
    setSamGit(false);
    setProjectName(deriveProjectName(repo.fullName));
  }

  function chooseSamGit() {
    setSamGit(true);
    setSelectedRepo(null);
    setProjectName((prev) => prev || 'New Project');
  }

  function back() {
    if (phase === 'intent') setPhase('source');
    else if (phase === 'ready') setPhase('intent');
  }

  const selectedIntent = INTENT_OPTIONS.find((o) => o.id === intent) ?? null;

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
          <div className="flex items-center gap-3">
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
          <button
            type="button"
            aria-label="Exit"
            className="inline-flex items-center justify-center w-11 h-11 rounded-full text-fg-muted hover:text-fg-primary hover:bg-white/5 bg-transparent border-none cursor-pointer transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 px-4 pb-10 sm:px-6">
          <div className="max-w-lg mx-auto pt-2 sm:pt-10">
            {phase === 'source' && (
              <SourceStep
                query={query}
                setQuery={setQuery}
                repos={filteredRepos}
                selectedRepo={selectedRepo}
                samGit={samGit}
                onSelectRepo={selectRepo}
                onChooseSamGit={chooseSamGit}
                projectName={projectName}
                setProjectName={setProjectName}
                canContinue={canContinueSource}
                onContinue={() => setPhase('intent')}
              />
            )}
            {phase === 'intent' && (
              <IntentStep
                projectName={projectName}
                selected={intent}
                onSelect={setIntent}
                onContinue={() => setPhase('ready')}
              />
            )}
            {phase === 'ready' && (
              <ReadyStep
                projectName={projectName}
                source={samGit ? 'SAM Git repository' : (selectedRepo?.fullName ?? '')}
                intent={selectedIntent}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── Step 1 · Bring your code ─────────────────────── */

interface SourceStepProps {
  query: string;
  setQuery: (v: string) => void;
  repos: MockRepo[];
  selectedRepo: MockRepo | null;
  samGit: boolean;
  onSelectRepo: (r: MockRepo) => void;
  onChooseSamGit: () => void;
  projectName: string;
  setProjectName: (v: string) => void;
  canContinue: boolean;
  onContinue: () => void;
}

function SourceStep({
  query,
  setQuery,
  repos,
  selectedRepo,
  samGit,
  onSelectRepo,
  onChooseSamGit,
  projectName,
  setProjectName,
  canContinue,
  onContinue,
}: SourceStepProps) {
  return (
    <div>
      <h1 className="sam-type-section-heading text-fg-primary mb-1">Bring your code</h1>
      <p className="sam-type-body text-fg-muted mb-6">
        A project links a codebase to chats, tasks, and agents. Pick where this one&apos;s code lives.
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
      <div className="flex flex-col gap-2 mb-3">
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

      {/* Start fresh */}
      <button
        type="button"
        aria-pressed={samGit}
        onClick={onChooseSamGit}
        className={`w-full text-left p-3 rounded-lg border border-dashed transition-all cursor-pointer bg-surface/50 mb-6 ${
          samGit ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0 text-accent">
            <Sparkles size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-fg-primary text-sm">No repo yet — start fresh</span>
            <p className="text-xs text-fg-muted mt-0.5">
              SAM creates a Git repo for you. Connect GitHub later anytime.
            </p>
          </div>
          {samGit ? (
            <Check size={14} className="text-accent shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-fg-muted/30 shrink-0" />
          )}
        </div>
      </button>

      {/* Inline name — auto-filled from the selection, editable */}
      {(selectedRepo || samGit) && (
        <label className="block mb-6">
          <span className="text-sm text-fg-muted">Project name</span>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="w-full mt-1.5 rounded-lg bg-surface border border-border-default text-fg-primary text-sm px-3 py-2.5 outline-none focus:border-accent transition-colors"
          />
          <span className="text-[11px] text-fg-muted/70 mt-1 block">
            Pre-filled from your selection — change it if you like.
          </span>
        </label>
      )}

      <button
        type="button"
        disabled={!canContinue}
        onClick={onContinue}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-black font-semibold text-sm py-3 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-opacity"
      >
        Continue <ArrowRight size={15} />
      </button>
    </div>
  );
}

/* ───────────────────── Step 2 · What do you want first ───────────────────── */

interface IntentStepProps {
  projectName: string;
  selected: IntentId | null;
  onSelect: (id: IntentId) => void;
  onContinue: () => void;
}

function IntentStep({ projectName, selected, onSelect, onContinue }: IntentStepProps) {
  return (
    <div>
      <h1 className="sam-type-section-heading text-fg-primary mb-1">
        What do you want to do first in {projectName.trim() || 'this project'}?
      </h1>
      <p className="sam-type-body text-fg-muted mb-6">
        We&apos;ll create the project and drop you straight into it — no empty screen.
      </p>

      <div className="flex flex-col gap-3 mb-6" role="group" aria-label="First action">
        {INTENT_OPTIONS.map((option) => {
          const isSelected = selected === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelect(option.id)}
              className={`w-full text-left p-4 rounded-lg border transition-all cursor-pointer group bg-surface ${
                isSelected ? 'border-accent ring-1 ring-accent' : 'border-border-default hover:border-fg-muted'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
                  {option.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-fg-primary text-sm">{option.label}</span>
                    {isSelected ? (
                      <Check size={16} className="text-accent shrink-0" />
                    ) : (
                      <ChevronRight
                        size={14}
                        className="text-fg-muted/20 group-hover:text-fg-muted/50 transition-colors shrink-0"
                      />
                    )}
                  </div>
                  <p className="text-sm text-fg-muted mt-0.5">{option.description}</p>
                  {option.profileHint && (
                    <div className="inline-flex items-center gap-1.5 mt-2 text-[11px] text-fg-muted/80 bg-white/[0.03] border border-border-default rounded-full px-2 py-0.5">
                      <Sparkles size={10} className="text-accent" />
                      {option.profileHint}
                      <span className="text-fg-muted/50">· customize later</span>
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-fg-muted/70 mb-3 text-center">
        SAM starts you with one conversational profile. Add specialized profiles when you need them.
      </p>

      <button
        type="button"
        disabled={selected === null}
        onClick={onContinue}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-black font-semibold text-sm py-3 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-opacity"
      >
        Create project <ArrowRight size={15} />
      </button>
    </div>
  );
}

/* ───────────────────────────── Step 3 · Ready ───────────────────────────── */

interface ReadyStepProps {
  projectName: string;
  source: string;
  intent: IntentOption | null;
}

function ReadyStep({ projectName, source, intent }: ReadyStepProps) {
  return (
    <div className="text-center pt-6">
      <div className="w-20 h-20 rounded-full bg-success/10 flex items-center justify-center mx-auto mb-4">
        <Check size={36} className="text-success" />
      </div>
      <h1 className="sam-type-page-title text-fg-primary mb-2">{projectName} is ready</h1>
      <p className="text-fg-muted max-w-sm mx-auto mb-6">
        Linked to <span className="text-fg-primary">{source}</span>. Here&apos;s where you&apos;re headed.
      </p>

      <div className="rounded-lg border border-accent/40 bg-accent/[0.06] p-4 text-left max-w-sm mx-auto mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent/15 flex items-center justify-center text-accent shrink-0">
            {intent?.icon ?? <MessageSquare size={18} />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-fg-primary">{intent?.label ?? 'Start chatting'}</p>
            <p className="text-xs text-fg-muted">{intent?.landing ?? 'Opens a new chat'}</p>
          </div>
        </div>
      </div>

      <button
        type="button"
        className="w-full max-w-xs mx-auto inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-black font-semibold text-sm py-3 cursor-pointer"
      >
        <Sparkles size={14} /> Let&apos;s go
      </button>
      <p className="text-xs text-fg-muted mt-3">You can change anything later in project settings.</p>
    </div>
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
