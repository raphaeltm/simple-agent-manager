/**
 * PROTOTYPE — "Project Onboarding" (reimagined project creation)
 *
 * Self-contained, unauthed design exploration. No API calls, no auth, mock data
 * only. Route: /prototype/project-onboarding
 *
 * Premise: today's /projects/new is a flat form that drops you into an empty
 * project. This reimagines creation as a short *guided onboarding* that:
 *   1. Connect — link a GitHub repo + branch and name the project (required).
 *   2. Discover — teach SAM's power surfaces (Agent Profiles, Triggers, Skills)
 *      with a "here's why" framing borrowed from the website's self-host setup.
 *      Fully skippable for power users.
 *   3. Kick off — an isolated, centered version of the project-chat composer
 *      (voice included) to start either a *task* or a *conversation*. Either way
 *      you land in the project, in motion — never an empty room.
 *
 * Visual language borrows from the account-level Choose-Your-Path wizard and the
 * project-chat composer (green-glow vignette, card options, dark glassy input).
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  GitBranch,
  Github,
  Lock,
  MessageSquare,
  Mic,
  Search,
  Send,
  Sparkles,
  SplitSquareVertical,
  Users,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { deriveProjectName, MOCK_REPOS, type MockRepo } from './mock-data';

type Phase = 'connect' | 'discover' | 'kickoff';

const STEPS: { id: Phase; label: string }[] = [
  { id: 'connect', label: 'Connect' },
  { id: 'discover', label: 'Discover' },
  { id: 'kickoff', label: 'Start' },
];

/* Feature surfaces SAM unlocks — taught during onboarding the way the website's
 * self-host setup explains *why* each piece matters, not just *what* it is. */
interface FeatureCard {
  id: string;
  icon: ReactNode;
  title: string;
  what: string;
  why: string;
}

const FEATURES: FeatureCard[] = [
  {
    id: 'profiles',
    icon: <Users size={18} />,
    title: 'Agent profiles',
    what: 'Named agents with their own model, tools, and instructions.',
    why: 'Keep a careful reviewer and a fast prototyper side by side — pick the right one per conversation instead of re-explaining context every time.',
  },
  {
    id: 'triggers',
    icon: <Zap size={18} />,
    title: 'Triggers',
    what: 'Run a profile automatically on a schedule or an event.',
    why: 'Have an agent triage new issues every morning or watch a branch — work happens while you sleep, on your terms.',
  },
  {
    id: 'skills',
    icon: <Wrench size={18} />,
    title: 'Skills',
    what: 'Reusable instructions + files an agent loads on demand.',
    why: 'Teach SAM your conventions once — release steps, a writing voice, a deploy checklist — and any profile can reach for it.',
  },
];

type KickoffMode = 'task' | 'conversation';

export function ProjectOnboardingPrototype() {
  const [phase, setPhase] = useState<Phase>('connect');

  // Step 1 — required info
  const [query, setQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<MockRepo | null>(null);
  const [projectName, setProjectName] = useState('');
  const [branch, setBranch] = useState('');

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

  function back() {
    if (phase === 'discover') setPhase('connect');
    else if (phase === 'kickoff') setPhase('discover');
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
                onContinue={() => setPhase('discover')}
              />
            )}
            {phase === 'discover' && (
              <DiscoverStep
                projectName={projectName}
                onContinue={() => setPhase('kickoff')}
                onSkip={() => setPhase('kickoff')}
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
              Agents branch off this when they work — your default branch stays untouched.
            </span>
          </label>
        </div>
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

/* ──────────────────── Step 2 · Discover what SAM gives you ──────────────────── */

interface DiscoverStepProps {
  projectName: string;
  onContinue: () => void;
  onSkip: () => void;
}

function DiscoverStep({ projectName, onContinue, onSkip }: DiscoverStepProps) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
          Step 2 of 3 · Optional
        </p>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer transition-colors"
        >
          Skip intro →
        </button>
      </div>

      <h1 className="sam-type-section-heading text-fg-primary mb-1">
        {projectName.trim() || 'Your project'} is more than a chat box
      </h1>
      <p className="sam-type-body text-fg-muted mb-6">
        Three things make SAM worth setting up. You don&apos;t need any of them to start — but
        here&apos;s what you can reach for as the project grows.
      </p>

      <div className="flex flex-col gap-3 mb-6">
        {FEATURES.map((f) => (
          <div
            key={f.id}
            className="rounded-lg border border-border-default bg-surface p-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
                {f.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-fg-primary text-sm">{f.title}</p>
                <p className="text-sm text-fg-muted mt-0.5">{f.what}</p>
                <p className="text-[13px] text-fg-muted/80 mt-2 leading-relaxed">
                  <span className="text-accent font-medium">Why it matters · </span>
                  {f.why}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-default bg-white/[0.02] p-3 mb-6 flex items-start gap-2.5">
        <Sparkles size={14} className="text-accent shrink-0 mt-0.5" />
        <p className="text-xs text-fg-muted leading-relaxed">
          SAM starts you with one conversational profile so you can begin right away. Add
          specialized profiles, triggers, and skills whenever you&apos;re ready — nothing here is
          required up front.
        </p>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-accent text-black font-semibold text-sm py-3 cursor-pointer transition-opacity"
      >
        Got it — let&apos;s start <ArrowRight size={15} />
      </button>
    </div>
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
