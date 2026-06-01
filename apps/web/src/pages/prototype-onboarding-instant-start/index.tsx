/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 *
 * Instant Start Onboarding Prototype
 *
 * This prototype demonstrates a "skip everything" flow where a new user
 * gets to a working environment in under 2 minutes by using SAM-managed
 * infrastructure and billing. The user picks a template repo (or connects
 * their own), types a task, and immediately sees the agent working.
 * Setup steps are revealed AFTER they've experienced value.
 *
 * Philosophy: "Show the value first, explain later."
 * Inspired by Vercel's zero-config deploy experience.
 */
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Code,
  ExternalLink,
  GitBranch,
  Key,
  Loader2,
  MessageSquare,
  Play,
  Rocket,
  Send,
  Settings,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MOCK_CHAT_MESSAGES,
  PROVISIONING_STEPS,
  SAMPLE_REPOS,
  TASK_SUGGESTIONS,
} from './mock-data';

/* ─── shared styles ─── */
const glass =
  'bg-[rgba(8,15,12,0.65)] backdrop-blur-[24px] backdrop-saturate-[1.35] border border-[rgba(34,197,94,0.12)] rounded-[10px]';
const btn =
  'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-[8px] font-medium text-sm transition-all cursor-pointer border-none';
const btnPrimary = `${btn} bg-green-600 hover:bg-green-700 text-white`;
const btnGhost = `${btn} bg-transparent hover:bg-white/5 text-[#9fb7ae]`;

type Phase = 'pick-repo' | 'pick-task' | 'provisioning' | 'agent-working' | 'setup-reveal';

/* ─── Phase 1: Pick a repo (or template) ─── */
function PickRepoPhase({ onSelect }: { onSelect: (repoId: string) => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Hero */}
      <div className="mb-8 mt-4">
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto mb-4">
          <Rocket size={28} className="text-green-400" />
        </div>
        <h1 className="text-3xl font-bold text-[#e6f2ee] mb-2">Start building in 60 seconds</h1>
        <p className="text-[#9fb7ae] max-w-md mx-auto">
          Pick a project and tell SAM what to build. No setup needed — we handle the infrastructure.
        </p>
      </div>

      {/* Repo cards */}
      <div className="w-full max-w-md space-y-3 mb-6">
        <p className="text-xs text-[#9fb7ae]/60 text-left font-medium uppercase tracking-wide">
          Choose a starting point
        </p>
        {SAMPLE_REPOS.map((repo) => (
          <button
            key={repo.id}
            onClick={() => onSelect(repo.id)}
            className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer group ${
              repo.id === 'own-repo'
                ? 'bg-transparent border-dashed border-[rgba(34,197,94,0.2)] hover:border-green-500/40 hover:bg-[rgba(34,197,94,0.04)]'
                : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.25)] hover:bg-[rgba(8,15,12,0.85)]'
            }`}
          >
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-lg flex items-center justify-center text-lg font-bold ${
                  repo.id === 'own-repo'
                    ? 'bg-[rgba(34,197,94,0.1)] text-green-400'
                    : 'bg-[rgba(34,197,94,0.08)] text-[#e6f2ee]'
                }`}
              >
                {repo.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#e6f2ee]">{repo.name}</span>
                  {repo.language && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(34,197,94,0.1)] text-green-400">
                      {repo.language}
                    </span>
                  )}
                </div>
                <p className="text-sm text-[#9fb7ae] truncate">{repo.description}</p>
              </div>
              <ChevronRight
                size={16}
                className="text-[#9fb7ae]/30 group-hover:text-green-400 transition-colors"
              />
            </div>
          </button>
        ))}
      </div>

      {/* Trust indicators */}
      <div className="flex items-center gap-4 text-[10px] text-[#9fb7ae]/40">
        <span className="flex items-center gap-1">
          <Zap size={10} /> Free trial included
        </span>
        <span className="flex items-center gap-1">
          <GitBranch size={10} /> No credit card required
        </span>
        <span className="flex items-center gap-1">
          <Code size={10} /> Cancel anytime
        </span>
      </div>
    </div>
  );
}

/* ─── Phase 2: Pick a task ─── */
function PickTaskPhase({
  repoName,
  onSubmit,
}: {
  repoName: string;
  onSubmit: (task: string) => void;
}) {
  const [task, setTask] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="max-w-md mx-auto">
      <div className="mb-6">
        <p className="text-xs text-green-400 font-medium mb-1 flex items-center gap-1">
          <Check size={12} /> Project: {repoName}
        </p>
        <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">What should SAM build?</h2>
        <p className="text-sm text-[#9fb7ae]">
          Describe a feature, bug fix, or improvement. Be specific — the agent will work on it
          autonomously.
        </p>
      </div>

      {/* Task input */}
      <div className={`${glass} p-4 mb-4`}>
        <textarea
          ref={textareaRef}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="e.g., Add a dark mode toggle to the settings page..."
          rows={3}
          className="w-full bg-transparent text-[#e6f2ee] text-sm placeholder:text-[#9fb7ae]/30 resize-none focus:outline-none"
        />
        <div className="flex justify-end mt-2">
          <button
            onClick={() => task && onSubmit(task)}
            disabled={!task.trim()}
            className={`${btnPrimary} ${!task.trim() ? 'opacity-40 cursor-not-allowed' : ''}`}
          >
            <Send size={14} /> Start building
          </button>
        </div>
      </div>

      {/* Suggestions */}
      <div className="space-y-4">
        {TASK_SUGGESTIONS.map((category) => (
          <div key={category.title}>
            <p className="text-xs text-[#9fb7ae]/50 font-medium mb-1.5">{category.title}</p>
            <div className="flex flex-wrap gap-1.5">
              {category.examples.map((example) => (
                <button
                  key={example}
                  onClick={() => setTask(example)}
                  className="text-[11px] px-2.5 py-1.5 rounded-md bg-[rgba(34,197,94,0.04)] border border-[rgba(34,197,94,0.08)] text-[#9fb7ae] hover:text-[#e6f2ee] hover:border-[rgba(34,197,94,0.2)] transition-all cursor-pointer"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Phase 3: Provisioning animation ─── */
function ProvisioningPhase({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [stepProgress, setStepProgress] = useState(0);

  useEffect(() => {
    if (currentStep >= PROVISIONING_STEPS.length) {
      const t = setTimeout(onComplete, 500);
      return () => clearTimeout(t);
    }

    const step = PROVISIONING_STEPS[currentStep];
    const interval = setInterval(() => {
      setStepProgress((p) => {
        if (p >= 100) {
          clearInterval(interval);
          setTimeout(() => {
            setCurrentStep((s) => s + 1);
            setStepProgress(0);
          }, 300);
          return 100;
        }
        return p + 100 / (step.duration / 50);
      });
    }, 50);

    return () => clearInterval(interval);
  }, [currentStep, onComplete]);

  return (
    <div className="max-w-sm mx-auto text-center">
      <div className="mb-8 mt-8">
        <Loader2 size={40} className="text-green-400 mx-auto mb-4 animate-spin" />
        <h2 className="text-xl font-bold text-[#e6f2ee] mb-1">Setting up your workspace</h2>
        <p className="text-sm text-[#9fb7ae]">This usually takes about 30 seconds</p>
      </div>

      <div className="space-y-3">
        {PROVISIONING_STEPS.map((step, i) => (
          <div
            key={step.id}
            className={`flex items-center gap-3 text-left px-4 py-3 rounded-lg transition-all ${
              i === currentStep
                ? 'bg-[rgba(34,197,94,0.06)] border border-[rgba(34,197,94,0.12)]'
                : i < currentStep
                  ? 'opacity-60'
                  : 'opacity-30'
            }`}
          >
            {i < currentStep ? (
              <Check size={16} className="text-green-400 flex-shrink-0" />
            ) : i === currentStep ? (
              <Loader2 size={16} className="text-green-400 flex-shrink-0 animate-spin" />
            ) : (
              <div className="w-4 h-4 rounded-full border border-[rgba(34,197,94,0.2)] flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[#e6f2ee]">{step.label}</p>
              <p className="text-xs text-[#9fb7ae]">{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Total progress bar */}
      <div className="mt-6">
        <div className="w-full h-1 bg-[rgba(34,197,94,0.1)] rounded-full overflow-hidden">
          <div
            className="h-full bg-green-500 rounded-full transition-all"
            style={{
              width: `${((currentStep + stepProgress / 100) / PROVISIONING_STEPS.length) * 100}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ─── Phase 4: Agent working (mock chat) ─── */
function AgentWorkingPhase({ onShowSetup }: { onShowSetup: () => void }) {
  const [visibleMessages, setVisibleMessages] = useState(1);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visibleMessages < MOCK_CHAT_MESSAGES.length) {
      const t = setTimeout(() => {
        setVisibleMessages((v) => v + 1);
      }, 2500);
      return () => clearTimeout(t);
    }
  }, [visibleMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages]);

  const allDone = visibleMessages >= MOCK_CHAT_MESSAGES.length;

  return (
    <div className="max-w-md mx-auto">
      {/* Chat header */}
      <div className="flex items-center justify-between mb-4 px-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-sm font-medium text-[#e6f2ee]">Claude Code</span>
          <span className="text-xs text-[#9fb7ae]/50">working on your task</span>
        </div>
        <span className="text-xs text-[#9fb7ae]/40">
          <Terminal size={12} className="inline mr-1" />
          johndoe/my-saas-app
        </span>
      </div>

      {/* Messages */}
      <div className={`${glass} p-4 space-y-4 max-h-[400px] overflow-y-auto`}>
        {MOCK_CHAT_MESSAGES.slice(0, visibleMessages).map((msg, i) => (
          <div key={i} className={`${msg.role === 'user' ? 'pl-8' : ''}`}>
            {/* Role indicator */}
            <div className="flex items-center gap-2 mb-1">
              <div
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  msg.role === 'user'
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'bg-green-500/20 text-green-400'
                }`}
              >
                {msg.role === 'user' ? 'Y' : 'C'}
              </div>
              <span className="text-xs text-[#9fb7ae]/50">{msg.timestamp}</span>
              {msg.role === 'agent' && 'status' in msg && msg.status === 'working' && (
                <Loader2 size={10} className="text-green-400 animate-spin" />
              )}
              {msg.role === 'agent' && 'status' in msg && msg.status === 'complete' && (
                <Check size={10} className="text-green-400" />
              )}
            </div>

            {/* Content */}
            <div className="text-sm text-[#e6f2ee] whitespace-pre-wrap leading-relaxed">
              {msg.content}
            </div>

            {/* Tool calls */}
            {msg.role === 'agent' && 'toolCalls' in msg && msg.toolCalls && (
              <div className="mt-2 space-y-0.5">
                {msg.toolCalls.map((tc, j) => (
                  <div
                    key={j}
                    className="text-[10px] text-[#9fb7ae]/50 font-mono flex items-center gap-1"
                  >
                    <Code size={8} /> {tc}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Loading indicator for next message */}
        {!allDone && (
          <div className="flex items-center gap-2 text-[#9fb7ae]/30">
            <Loader2 size={12} className="animate-spin" />
            <span className="text-xs">Agent is working...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Post-completion CTA */}
      {allDone && (
        <div className="mt-6 text-center">
          <div className="bg-[rgba(34,197,94,0.06)] border border-[rgba(34,197,94,0.15)] rounded-[10px] p-5">
            <Sparkles size={24} className="text-green-400 mx-auto mb-2" />
            <h3 className="font-semibold text-[#e6f2ee] mb-1">That's SAM in action!</h3>
            <p className="text-sm text-[#9fb7ae] mb-4">
              Your agent just wrote code, ran tests, and opened a PR — all from a single message.
              Want to keep going? Let's set up your full account.
            </p>
            <div className="flex flex-col gap-2">
              <button onClick={onShowSetup} className={btnPrimary}>
                <Settings size={14} /> Set up my account for unlimited use
              </button>
              <button className={btnGhost}>
                <MessageSquare size={14} /> Send another task first
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Phase 5: Setup reveal (progressive disclosure) ─── */
function SetupRevealPhase() {
  const [expandedSection, setExpandedSection] = useState<string | null>('ai');

  const sections = [
    {
      id: 'ai',
      title: 'AI Agent Billing',
      subtitle: 'Control how you pay for AI usage',
      icon: <Key size={16} />,
      status: 'trial' as const,
      content: (
        <div className="space-y-3">
          <p className="text-sm text-[#9fb7ae]">
            You just used SAM trial credits. To keep going, choose how you want to pay:
          </p>
          <div className="space-y-2">
            {[
              {
                label: 'Use my own API key',
                desc: 'Pay-per-token to Anthropic directly',
                recommended: false,
              },
              {
                label: 'Use my Claude Pro subscription',
                desc: 'Already paying $20/mo? Use it here',
                recommended: true,
              },
              {
                label: 'Keep using SAM credits',
                desc: 'Pay-as-you-go with budget controls',
                recommended: false,
              },
            ].map((opt) => (
              <button
                key={opt.label}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)] text-sm transition-all cursor-pointer bg-transparent"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[#e6f2ee]">{opt.label}</span>
                  {opt.recommended && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                      Popular
                    </span>
                  )}
                </div>
                <p className="text-xs text-[#9fb7ae]/60 mt-0.5">{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: 'cloud',
      title: 'Cloud Infrastructure',
      subtitle: 'Where your code runs',
      icon: <Sparkles size={16} />,
      status: 'trial' as const,
      content: (
        <div className="space-y-3">
          <p className="text-sm text-[#9fb7ae]">
            SAM used trial infrastructure for your first task. For ongoing use, you can:
          </p>
          <div className="space-y-2">
            <button className="w-full text-left px-3 py-2.5 rounded-lg border border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)] text-sm transition-all cursor-pointer bg-transparent">
              <span className="text-[#e6f2ee]">Connect my Hetzner account</span>
              <p className="text-xs text-[#9fb7ae]/60 mt-0.5">
                Most cost-effective — ~$5-20/mo for typical use
              </p>
            </button>
            <button className="w-full text-left px-3 py-2.5 rounded-lg border border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)] text-sm transition-all cursor-pointer bg-transparent">
              <span className="text-[#e6f2ee]">Keep using SAM infrastructure</span>
              <p className="text-xs text-[#9fb7ae]/60 mt-0.5">
                Simpler setup — billed per-minute
              </p>
            </button>
          </div>
        </div>
      ),
    },
    {
      id: 'github',
      title: 'GitHub Integration',
      subtitle: 'Connect your repositories',
      icon: <GitBranch size={16} />,
      status: 'connected' as const,
      content: (
        <div>
          <div className="flex items-center gap-2 text-green-400 mb-2">
            <Check size={14} />
            <span className="text-sm font-medium">Connected</span>
          </div>
          <p className="text-sm text-[#9fb7ae]">
            Your GitHub account is connected. You can manage repo access in Settings.
          </p>
        </div>
      ),
    },
  ];

  return (
    <div className="max-w-md mx-auto">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">You've seen what SAM can do</h2>
        <p className="text-[#9fb7ae]">
          Set up your account for unlimited use. Each section takes about 1 minute.
        </p>
      </div>

      <div className="space-y-3">
        {sections.map((section) => (
          <div key={section.id} className={`${glass} overflow-hidden`}>
            <button
              onClick={() =>
                setExpandedSection(expandedSection === section.id ? null : section.id)
              }
              className="w-full flex items-center gap-3 p-4 bg-transparent border-none cursor-pointer text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-[rgba(34,197,94,0.1)] flex items-center justify-center text-green-400">
                {section.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[#e6f2ee]">{section.title}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      section.status === 'connected'
                        ? 'bg-green-500/20 text-green-400'
                        : 'bg-amber-500/20 text-amber-400'
                    }`}
                  >
                    {section.status === 'connected' ? 'Done' : 'Trial'}
                  </span>
                </div>
                <p className="text-xs text-[#9fb7ae]">{section.subtitle}</p>
              </div>
              <ChevronDown
                size={16}
                className={`text-[#9fb7ae]/30 transition-transform ${
                  expandedSection === section.id ? 'rotate-180' : ''
                }`}
              />
            </button>
            {expandedSection === section.id && (
              <div className="px-4 pb-4 border-t border-[rgba(34,197,94,0.06)] pt-3">
                {section.content}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 text-center">
        <button className={btnPrimary}>
          <Rocket size={14} /> Save and go to dashboard
        </button>
        <p className="text-[10px] text-[#9fb7ae]/40 mt-2">
          You can change any of these in Settings later
        </p>
      </div>
    </div>
  );
}

/* ─── Main Prototype Component ─── */
export function PrototypeInstantStart() {
  const [phase, setPhase] = useState<Phase>('pick-repo');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  const repoName =
    selectedRepo === 'own-repo'
      ? 'my-repo'
      : SAMPLE_REPOS.find((r) => r.id === selectedRepo)?.name ?? '';

  return (
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      className="bg-[#0b1110] text-[#e6f2ee]"
    >
      {/* Minimal header */}
      <div className="sticky top-0 z-50 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-b border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-green-500/20 flex items-center justify-center text-green-400 text-xs font-bold">
              S
            </div>
            <span className="text-sm font-semibold text-[#e6f2ee]">SAM</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-[#9fb7ae]/50">
            {phase === 'pick-repo' && <span>Choose a project</span>}
            {phase === 'pick-task' && (
              <span className="flex items-center gap-1">
                <Check size={10} className="text-green-400" /> {repoName}
              </span>
            )}
            {phase === 'provisioning' && (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin text-green-400" /> Setting up...
              </span>
            )}
            {phase === 'agent-working' && (
              <span className="flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" /> Agent
                working
              </span>
            )}
            {phase === 'setup-reveal' && <span>Complete your setup</span>}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        {phase === 'pick-repo' && (
          <PickRepoPhase
            onSelect={(id) => {
              setSelectedRepo(id);
              setPhase('pick-task');
            }}
          />
        )}
        {phase === 'pick-task' && (
          <PickTaskPhase
            repoName={repoName}
            onSubmit={() => setPhase('provisioning')}
          />
        )}
        {phase === 'provisioning' && (
          <ProvisioningPhase onComplete={() => setPhase('agent-working')} />
        )}
        {phase === 'agent-working' && (
          <AgentWorkingPhase onShowSetup={() => setPhase('setup-reveal')} />
        )}
        {phase === 'setup-reveal' && <SetupRevealPhase />}
      </div>

      {/* Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-t border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-2 flex justify-between items-center">
          <span className="text-[10px] text-[#9fb7ae]/40">PROTOTYPE — Instant Start</span>
          <div className="flex gap-2 text-[10px] text-[#9fb7ae]/30">
            {(['pick-repo', 'pick-task', 'provisioning', 'agent-working', 'setup-reveal'] as Phase[]).map(
              (p) => (
                <button
                  key={p}
                  onClick={() => setPhase(p)}
                  className={`px-2 py-0.5 rounded cursor-pointer border-none ${
                    phase === p ? 'bg-green-500/20 text-green-400' : 'bg-transparent'
                  }`}
                >
                  {p.replace('-', ' ')}
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
