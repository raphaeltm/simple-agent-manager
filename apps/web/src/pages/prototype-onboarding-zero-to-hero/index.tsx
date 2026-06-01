/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 *
 * Zero-to-Hero Onboarding Walkthrough Prototype
 *
 * This prototype demonstrates a step-by-step onboarding flow that explains
 * every concept to users who may not understand OAuth, API keys, cloud providers,
 * or billing implications. Each step has plain-language explanations of WHAT
 * the credential is, WHY it's needed, and WHAT the cost implications are.
 *
 * Target user: Technical but not deeply technical — understands code, may not
 * understand infrastructure, API billing, or credential types.
 */
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Cloud,
  Code,
  CreditCard,
  DollarSign,
  ExternalLink,
  GitBranch,
  HelpCircle,
  Key,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  Rocket,
  Search,
  Server,
  Shield,
  Sparkles,
  Zap,
} from 'lucide-react';
import { useCallback, useState } from 'react';

import {
  MOCK_AGENTS,
  MOCK_CLOUD_PROVIDERS,
  MOCK_REPOS,
  WALKTHROUGH_STEPS,
  type MockAgent,
} from './mock-data';

/* ─── shared style helpers ─── */
const glass =
  'bg-[rgba(8,15,12,0.65)] backdrop-blur-[24px] backdrop-saturate-[1.35] border border-[rgba(34,197,94,0.12)] rounded-[10px]';
const glassCard = `${glass} p-5`;
const btn =
  'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-[8px] font-medium text-sm transition-all cursor-pointer border-none';
const btnPrimary = `${btn} bg-green-600 hover:bg-green-700 text-white`;
const btnSecondary = `${btn} bg-[rgba(34,197,94,0.1)] hover:bg-[rgba(34,197,94,0.2)] text-green-400 border border-[rgba(34,197,94,0.2)]`;
const btnGhost = `${btn} bg-transparent hover:bg-white/5 text-[#9fb7ae]`;
const infoBox =
  'bg-[rgba(34,197,94,0.06)] border border-[rgba(34,197,94,0.15)] rounded-[8px] p-4 text-sm text-[#9fb7ae]';
const tipBox =
  'bg-[rgba(245,158,11,0.06)] border border-[rgba(245,158,11,0.15)] rounded-[8px] p-4 text-sm text-[#9fb7ae]';

/* ─── Explainer tooltip ─── */
function Explainer({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-[rgba(34,197,94,0.15)] text-green-400 text-[10px] cursor-pointer border-none ml-1 hover:bg-[rgba(34,197,94,0.3)]"
        aria-label="More info"
      >
        <HelpCircle size={10} />
      </button>
      {open && (
        <span className="absolute left-0 top-6 z-50 w-64 p-3 rounded-lg bg-[#13201d] border border-[rgba(34,197,94,0.2)] text-xs text-[#9fb7ae] shadow-xl">
          {text}
          <button
            onClick={() => setOpen(false)}
            className="block mt-2 text-green-400 text-[10px] cursor-pointer bg-transparent border-none"
          >
            Got it
          </button>
        </span>
      )}
    </span>
  );
}

/* ─── Progress bar ─── */
function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = ((current + 1) / total) * 100;
  return (
    <div className="w-full h-1 bg-[rgba(34,197,94,0.1)] rounded-full overflow-hidden">
      <div
        className="h-full bg-green-500 rounded-full transition-all duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ─── Step: Welcome ─── */
function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col items-center text-center max-w-lg mx-auto">
      <div className="w-20 h-20 rounded-full bg-[rgba(34,197,94,0.1)] flex items-center justify-center mb-6">
        <Sparkles size={36} className="text-green-400" />
      </div>
      <h1 className="text-3xl font-bold text-[#e6f2ee] mb-3">Welcome to SAM</h1>
      <p className="text-lg text-[#9fb7ae] mb-2">Your Simple Agent Manager</p>
      <p className="text-sm text-[#9fb7ae]/70 mb-8 max-w-md">
        SAM gives AI coding agents their own cloud computer to work on your code.
        You chat, they code — in a real development environment with your actual repo.
      </p>

      <div className={`${infoBox} mb-8 text-left max-w-md`}>
        <p className="font-medium text-green-400 mb-2 flex items-center gap-2">
          <Shield size={14} /> What we'll set up in the next few minutes:
        </p>
        <ol className="list-decimal pl-5 space-y-1 text-[#9fb7ae]">
          <li>
            <strong className="text-[#e6f2ee]">An AI agent</strong> — the brain that writes code
          </li>
          <li>
            <strong className="text-[#e6f2ee]">A cloud account</strong> — the computer it works on
          </li>
          <li>
            <strong className="text-[#e6f2ee]">Your GitHub</strong> — the code it works with
          </li>
        </ol>
        <p className="mt-3 text-xs text-[#9fb7ae]/60">
          Each step takes about 1-2 minutes. We'll explain everything along the way.
        </p>
      </div>

      <button onClick={onNext} className={btnPrimary}>
        Let's get started <ArrowRight size={16} />
      </button>
    </div>
  );
}

/* ─── Step: Concept (How SAM Works) ─── */
function ConceptStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-2">How SAM Works</h2>
      <p className="text-[#9fb7ae] mb-6">The 30-second version</p>

      <div className="space-y-4 mb-8">
        {[
          {
            icon: <MessageSquare size={20} />,
            title: 'You describe what you want',
            desc: '"Add dark mode to the settings page" or "Fix the login bug on mobile"',
          },
          {
            icon: <Server size={20} />,
            title: 'SAM spins up a cloud computer',
            desc: 'A real VM with your repo cloned, dependencies installed, and tools ready',
          },
          {
            icon: <Code size={20} />,
            title: 'Your AI agent writes the code',
            desc: 'It runs in a real terminal — editing files, running tests, using git',
          },
          {
            icon: <GitBranch size={20} />,
            title: 'You review a PR',
            desc: 'The agent opens a pull request. You review, merge, done.',
          },
        ].map((step, i) => (
          <div key={i} className="flex gap-4 items-start">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[rgba(34,197,94,0.1)] flex items-center justify-center text-green-400">
              {step.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-[#e6f2ee] mb-0.5">{step.title}</p>
              <p className="text-sm text-[#9fb7ae]">{step.desc}</p>
            </div>
            {i < 3 && (
              <div className="flex-shrink-0 w-10 flex justify-center pt-10">
                <div className="w-px h-4 bg-[rgba(34,197,94,0.2)]" />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className={tipBox}>
        <p className="flex items-center gap-2 font-medium text-amber-400 mb-1">
          <Zap size={14} /> Think of it like this
        </p>
        <p>
          SAM is like hiring a developer who brings their own laptop. You tell them what to build,
          they work on it, and hand you a PR to review. The "laptop" is a cloud VM.
          The "developer" is an AI agent.
        </p>
      </div>

      <div className="flex justify-between mt-8">
        <button onClick={onBack} className={btnGhost}>
          <ArrowLeft size={16} /> Back
        </button>
        <button onClick={onNext} className={btnPrimary}>
          Got it, let's set up <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step: Choose Agent ─── */
function AgentStep({
  onNext,
  onBack,
  selectedAgent,
  onSelectAgent,
}: {
  onNext: () => void;
  onBack: () => void;
  selectedAgent: MockAgent | null;
  onSelectAgent: (a: MockAgent) => void;
}) {
  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">Choose Your AI Agent</h2>
      <p className="text-[#9fb7ae] mb-2">Which AI will write your code?</p>
      <p className="text-sm text-[#9fb7ae]/60 mb-6">
        An "agent" is an AI model that can work autonomously in a terminal — editing files,
        running commands, and using git. SAM supports several agents.
      </p>

      <div className="space-y-3 mb-6">
        {MOCK_AGENTS.map((agent) => (
          <button
            key={agent.id}
            onClick={() => onSelectAgent(agent)}
            className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer ${
              selectedAgent?.id === agent.id
                ? 'bg-[rgba(34,197,94,0.1)] border-green-500/40'
                : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-[rgba(34,197,94,0.1)] flex items-center justify-center text-green-400 font-bold text-lg">
                {agent.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#e6f2ee]">{agent.name}</span>
                  <span className="text-xs text-[#9fb7ae]/60">by {agent.provider}</span>
                  {selectedAgent?.id === agent.id && (
                    <Check size={14} className="text-green-400 ml-auto" />
                  )}
                </div>
                <p className="text-sm text-[#9fb7ae] mt-1">{agent.description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {selectedAgent && (
        <div className={infoBox}>
          <p className="flex items-center gap-2 font-medium text-green-400 mb-1">
            <Check size={14} /> Great choice!
          </p>
          <p>
            You selected <strong className="text-[#e6f2ee]">{selectedAgent.name}</strong>.
            Next, we'll set up how you pay for its usage.
          </p>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <button onClick={onBack} className={btnGhost}>
          <ArrowLeft size={16} /> Back
        </button>
        <button onClick={onNext} disabled={!selectedAgent} className={`${btnPrimary} ${!selectedAgent ? 'opacity-40 cursor-not-allowed' : ''}`}>
          Next: How you pay <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step: Billing / Provider Mode ─── */
function BillingStep({
  onNext,
  onBack,
  selectedAgent,
  selectedMode,
  onSelectMode,
}: {
  onNext: () => void;
  onBack: () => void;
  selectedAgent: MockAgent | null;
  selectedMode: string | null;
  onSelectMode: (mode: string) => void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [showValidation, setShowValidation] = useState(false);

  if (!selectedAgent) return null;

  const handleValidate = () => {
    setShowValidation(true);
    setTimeout(() => setShowValidation(false), 2000);
  };

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">How You Pay for AI</h2>
      <p className="text-[#9fb7ae] mb-2">
        Your {selectedAgent.name} agent needs access to the AI model.
        You have three options:
      </p>

      <div className={`${tipBox} mb-6`}>
        <p className="flex items-center gap-2 font-medium text-amber-400 mb-1">
          <DollarSign size={14} /> Understanding AI costs
        </p>
        <p className="text-xs">
          AI agents use "tokens" — roughly 1 token per word. A typical coding task uses
          10,000-100,000 tokens. With your own API key, that's roughly $0.03 to $1.50 per task
          depending on the model.
          <Explainer text="Tokens are how AI models measure text. Input (your prompt) and output (the code) both cost tokens. More complex tasks = more tokens = higher cost. But even complex tasks rarely exceed a few dollars." />
        </p>
      </div>

      <div className="space-y-3 mb-6">
        {selectedAgent.subscriptionOptions.map((opt) => (
          <button
            key={opt.providerMode}
            onClick={() => onSelectMode(opt.providerMode)}
            className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer ${
              selectedMode === opt.providerMode
                ? 'bg-[rgba(34,197,94,0.1)] border-green-500/40'
                : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-[#e6f2ee] flex items-center gap-2">
                {opt.providerMode === 'user-api-key' && <Key size={14} />}
                {opt.providerMode === 'oauth' && <Lock size={14} />}
                {opt.providerMode === 'sam' && <CreditCard size={14} />}
                {opt.name}
              </span>
              {selectedMode === opt.providerMode && <Check size={14} className="text-green-400" />}
            </div>
            <p className="text-sm text-[#9fb7ae] mb-2">{opt.description}</p>
            <p className="text-xs text-green-400/80 font-medium">{opt.cost}</p>
          </button>
        ))}
      </div>

      {/* Conditional input based on selected mode */}
      {selectedMode === 'user-api-key' && (
        <div className={glassCard}>
          <label className="block text-sm font-medium text-[#e6f2ee] mb-2">
            {selectedAgent.credentialLabel}
            <Explainer text="An API key is like a password that lets SAM use the AI model on your behalf. You generate it from the provider's website. SAM encrypts it and never shares it." />
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-ant-..."
              className="flex-1 px-3 py-2 rounded-lg bg-[#0e1a17] border border-[rgba(34,197,94,0.12)] text-[#e6f2ee] text-sm placeholder:text-[#9fb7ae]/40 focus:outline-none focus:border-green-500/40"
            />
            <button
              onClick={handleValidate}
              disabled={!apiKey}
              className={`${btnSecondary} ${!apiKey ? 'opacity-40' : ''}`}
            >
              {showValidation ? <Check size={14} /> : 'Validate'}
            </button>
          </div>
          <p className="mt-2 text-xs text-[#9fb7ae]/60 flex items-center gap-1">
            <Shield size={10} /> Your key is encrypted and stored securely. SAM never shares it.
          </p>
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="text-xs text-green-400 mt-1 inline-flex items-center gap-1 hover:underline"
          >
            {selectedAgent.credentialHelp} <ExternalLink size={10} />
          </a>
        </div>
      )}

      {selectedMode === 'oauth' && (
        <div className={glassCard}>
          <p className="text-sm text-[#e6f2ee] mb-3">
            We'll connect to your existing subscription via OAuth.
            <Explainer text="OAuth is a secure way to let SAM access your subscription without giving us your password. You'll be redirected to the provider's website to approve access." />
          </p>
          <button className={btnSecondary}>
            <Lock size={14} /> Connect {selectedAgent.provider} Account
          </button>
          <p className="mt-2 text-xs text-[#9fb7ae]/60">
            You'll be redirected to {selectedAgent.provider} to approve access, then sent back here.
          </p>
        </div>
      )}

      {selectedMode === 'sam' && (
        <div className={glassCard}>
          <p className="text-sm text-[#e6f2ee] mb-3">
            SAM will handle AI billing through Cloudflare's infrastructure.
            You can set spending limits.
          </p>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-[#9fb7ae] mb-1 block">Daily token budget</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="10000"
                  max="1000000"
                  defaultValue="100000"
                  className="flex-1 accent-green-500"
                />
                <span className="text-sm text-[#e6f2ee] font-mono w-20 text-right">100K</span>
              </div>
              <p className="text-xs text-[#9fb7ae]/60 mt-0.5">~$0.30-$1.50/day depending on model</p>
            </div>
            <div>
              <label className="text-xs text-[#9fb7ae] mb-1 block">Monthly cost cap</label>
              <div className="flex items-center gap-2">
                <span className="text-[#9fb7ae]">$</span>
                <input
                  type="number"
                  defaultValue={50}
                  className="w-24 px-3 py-1.5 rounded-lg bg-[#0e1a17] border border-[rgba(34,197,94,0.12)] text-[#e6f2ee] text-sm focus:outline-none focus:border-green-500/40"
                />
                <span className="text-xs text-[#9fb7ae]">/month</span>
              </div>
            </div>
          </div>
          <p className="mt-3 text-xs text-[#9fb7ae]/60 flex items-center gap-1">
            <Shield size={10} /> SAM will pause agents if they hit your daily or monthly limit.
            You're always in control.
          </p>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <button onClick={onBack} className={btnGhost}>
          <ArrowLeft size={16} /> Back
        </button>
        <button onClick={onNext} disabled={!selectedMode} className={`${btnPrimary} ${!selectedMode ? 'opacity-40 cursor-not-allowed' : ''}`}>
          Next: Where code runs <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step: Cloud Provider ─── */
function CloudStep({
  onNext,
  onBack,
  selectedProvider,
  onSelectProvider,
}: {
  onNext: () => void;
  onBack: () => void;
  selectedProvider: string | null;
  onSelectProvider: (id: string) => void;
}) {
  const [token, setToken] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState('fsn1');
  const [selectedSize, setSelectedSize] = useState('small');
  const [useSamInfra, setUseSamInfra] = useState(false);

  const provider = MOCK_CLOUD_PROVIDERS.find((p) => p.id === selectedProvider);

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">Where Your Code Runs</h2>
      <p className="text-[#9fb7ae] mb-2">
        AI agents need a real computer to work on. SAM creates temporary cloud VMs for each task.
      </p>

      <div className={`${infoBox} mb-6`}>
        <p className="flex items-center gap-2 font-medium text-green-400 mb-1">
          <Cloud size={14} /> Why a cloud VM?
        </p>
        <p className="text-xs">
          Unlike ChatGPT, coding agents need to actually run code — install packages, execute tests,
          use git. They need a real Linux machine. SAM creates one for each task, then shuts it down
          when done. You only pay for the time it's running.
          <Explainer text="VMs (Virtual Machines) are like renting a computer in the cloud. SAM creates them automatically — you don't need to know how to manage servers. They're created when a task starts and destroyed when it's done." />
        </p>
      </div>

      {/* Option: BYOC or SAM-managed */}
      <div className="space-y-3 mb-6">
        <button
          onClick={() => { onSelectProvider('hetzner'); setUseSamInfra(false); }}
          className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer ${
            selectedProvider === 'hetzner' && !useSamInfra
              ? 'bg-[rgba(34,197,94,0.1)] border-green-500/40'
              : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-[#e6f2ee] flex items-center gap-2">
              <Key size={14} /> Bring my own cloud account
            </span>
            {selectedProvider === 'hetzner' && !useSamInfra && <Check size={14} className="text-green-400" />}
          </div>
          <p className="text-sm text-[#9fb7ae]">
            Use your own Hetzner account. You control costs, regions, and VM sizes.
            Most cost-effective for regular use.
          </p>
          <p className="text-xs text-green-400/80 font-medium mt-1">
            ~$5-20/month for a small VM running a few hours/day
          </p>
        </button>

        <button
          onClick={() => { setUseSamInfra(true); onSelectProvider('sam-managed'); }}
          className={`w-full text-left p-4 rounded-[10px] border transition-all cursor-pointer ${
            useSamInfra
              ? 'bg-[rgba(34,197,94,0.1)] border-green-500/40'
              : 'bg-[rgba(8,15,12,0.65)] border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
          }`}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="font-semibold text-[#e6f2ee] flex items-center gap-2">
              <Rocket size={14} /> Use SAM-managed infrastructure
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                Fastest setup
              </span>
            </span>
            {useSamInfra && <Check size={14} className="text-green-400" />}
          </div>
          <p className="text-sm text-[#9fb7ae]">
            SAM provides the infrastructure. No cloud account needed — just start coding.
            Great for trying SAM out.
          </p>
          <p className="text-xs text-green-400/80 font-medium mt-1">
            Included in SAM credits, or billed per-minute
          </p>
        </button>
      </div>

      {/* BYOC: Hetzner setup */}
      {selectedProvider === 'hetzner' && !useSamInfra && provider && (
        <div className={glassCard}>
          <label className="block text-sm font-medium text-[#e6f2ee] mb-2">
            {provider.credentialLabel}
            <Explainer text="A Hetzner API token lets SAM create and destroy VMs on your Hetzner account. SAM never uses it for anything else. You can revoke it anytime from the Hetzner console." />
          </label>
          <div className="flex gap-2 mb-3">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="hcloud_..."
              className="flex-1 px-3 py-2 rounded-lg bg-[#0e1a17] border border-[rgba(34,197,94,0.12)] text-[#e6f2ee] text-sm placeholder:text-[#9fb7ae]/40 focus:outline-none focus:border-green-500/40"
            />
            <button
              onClick={() => { setShowValidation(true); setTimeout(() => setShowValidation(false), 2000); }}
              className={`${btnSecondary} ${!token ? 'opacity-40' : ''}`}
            >
              {showValidation ? <Check size={14} /> : 'Validate'}
            </button>
          </div>
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="text-xs text-green-400 inline-flex items-center gap-1 hover:underline mb-4 block"
          >
            {provider.credentialHelp} <ExternalLink size={10} />
          </a>

          {/* Location picker */}
          <div className="mb-4">
            <label className="text-xs text-[#9fb7ae] mb-2 block font-medium">
              Preferred region
              <Explainer text="Choose a region close to you or your users for faster performance. All regions have the same features and pricing." />
            </label>
            <div className="grid grid-cols-2 gap-2">
              {provider.locations.map((loc) => (
                <button
                  key={loc.id}
                  onClick={() => setSelectedLocation(loc.id)}
                  className={`text-left px-3 py-2 rounded-lg border text-xs transition-all cursor-pointer ${
                    selectedLocation === loc.id
                      ? 'bg-[rgba(34,197,94,0.1)] border-green-500/30 text-[#e6f2ee]'
                      : 'bg-transparent border-[rgba(34,197,94,0.08)] text-[#9fb7ae] hover:border-[rgba(34,197,94,0.2)]'
                  }`}
                >
                  <span className="mr-1">{loc.flag}</span> {loc.name}
                </button>
              ))}
            </div>
          </div>

          {/* VM size picker */}
          <div>
            <label className="text-xs text-[#9fb7ae] mb-2 block font-medium">
              Default VM size
              <Explainer text="Larger VMs build faster and can handle bigger repos, but cost more. You can change this per-task later. Start small — you can always upgrade." />
            </label>
            <div className="space-y-2">
              {provider.vmSizes.map((size) => (
                <button
                  key={size.name}
                  onClick={() => setSelectedSize(size.name)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-all cursor-pointer flex items-center justify-between ${
                    selectedSize === size.name
                      ? 'bg-[rgba(34,197,94,0.1)] border-green-500/30'
                      : 'bg-transparent border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
                  }`}
                >
                  <div>
                    <span className="font-medium text-[#e6f2ee]">{size.label}</span>
                    <span className="text-[#9fb7ae] ml-2">{size.specs}</span>
                  </div>
                  <span className="text-green-400/80 font-medium">{size.priceHourly}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SAM-managed */}
      {useSamInfra && (
        <div className={glassCard}>
          <p className="text-sm text-[#e6f2ee] mb-2 flex items-center gap-2">
            <Check size={14} className="text-green-400" /> No setup needed!
          </p>
          <p className="text-sm text-[#9fb7ae]">
            SAM will automatically provision infrastructure for your tasks.
            You can switch to your own cloud account later in Settings.
          </p>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <button onClick={onBack} className={btnGhost}>
          <ArrowLeft size={16} /> Back
        </button>
        <button onClick={onNext} disabled={!selectedProvider && !useSamInfra} className={`${btnPrimary} ${!selectedProvider && !useSamInfra ? 'opacity-40 cursor-not-allowed' : ''}`}>
          Next: Connect GitHub <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step: GitHub ─── */
function GitHubStep({
  onNext,
  onBack,
  connected,
  onConnect,
}: {
  onNext: () => void;
  onBack: () => void;
  connected: boolean;
  onConnect: () => void;
}) {
  const [selectedRepo, setSelectedRepo] = useState<number | null>(null);
  const [search, setSearch] = useState('');

  const filtered = MOCK_REPOS.filter(
    (r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.description.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">Connect Your Code</h2>
      <p className="text-[#9fb7ae] mb-2">
        SAM needs access to your GitHub repos so agents can clone, branch, and open PRs.
      </p>

      <div className={`${infoBox} mb-6`}>
        <p className="flex items-center gap-2 font-medium text-green-400 mb-1">
          <Shield size={14} /> How GitHub access works
        </p>
        <p className="text-xs">
          SAM installs as a GitHub App on your account. This means SAM can only access repos
          you explicitly allow — not your entire account. You can change this anytime from
          GitHub settings.
          <Explainer text="A GitHub App is different from a personal access token. It has granular permissions — you choose which repos it can see. SAM needs repo read/write access to clone code and create PRs." />
        </p>
      </div>

      {!connected ? (
        <div className={glassCard}>
          <div className="text-center">
            <GitBranch size={32} className="text-green-400 mx-auto mb-3" />
            <p className="text-sm text-[#e6f2ee] mb-4">
              Click below to install the SAM GitHub App.
              You'll choose which repos to give SAM access to.
            </p>
            <button onClick={onConnect} className={btnPrimary}>
              <GitBranch size={16} /> Install SAM GitHub App
            </button>
            <p className="mt-3 text-xs text-[#9fb7ae]/60">
              You'll be redirected to GitHub, then sent back here.
            </p>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 text-green-400 mb-4">
            <Check size={16} />
            <span className="text-sm font-medium">GitHub connected! Choose a repo for your first project.</span>
          </div>
          <div className="relative mb-3">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9fb7ae]/50" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search repositories..."
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#0e1a17] border border-[rgba(34,197,94,0.12)] text-[#e6f2ee] text-sm placeholder:text-[#9fb7ae]/40 focus:outline-none focus:border-green-500/40"
            />
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {filtered.map((repo) => (
              <button
                key={repo.id}
                onClick={() => setSelectedRepo(repo.id)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-all cursor-pointer ${
                  selectedRepo === repo.id
                    ? 'bg-[rgba(34,197,94,0.1)] border-green-500/30'
                    : 'bg-transparent border-[rgba(34,197,94,0.08)] hover:border-[rgba(34,197,94,0.2)]'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium text-[#e6f2ee]">{repo.fullName}</span>
                    <p className="text-xs text-[#9fb7ae] mt-0.5">{repo.description}</p>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[rgba(34,197,94,0.1)] text-green-400">
                      {repo.language}
                    </span>
                    <p className="text-[10px] text-[#9fb7ae]/50 mt-0.5">{repo.updatedAt}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-between mt-8">
        <button onClick={onBack} className={btnGhost}>
          <ArrowLeft size={16} /> Back
        </button>
        <button
          onClick={onNext}
          disabled={!connected}
          className={`${btnPrimary} ${!connected ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          Next: Your first task <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

/* ─── Step: First Task ─── */
function FirstTaskStep({ onBack }: { onBack: () => void }) {
  const [task, setTask] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [progress, setProgress] = useState(0);

  const suggestions = [
    'Add a dark mode toggle to the settings page',
    'Write unit tests for the auth module',
    'Fix the responsive layout on the mobile nav',
    'Add TypeScript types to the API client',
  ];

  const handleSubmit = () => {
    if (!task) return;
    setSubmitted(true);
    const interval = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(interval);
          return 100;
        }
        return p + 2;
      });
    }, 100);
  };

  return (
    <div className="max-w-lg mx-auto">
      <h2 className="text-2xl font-bold text-[#e6f2ee] mb-1">Your First Task</h2>
      <p className="text-[#9fb7ae] mb-6">
        You're all set up! Describe what you want built and SAM will handle the rest.
      </p>

      {!submitted ? (
        <>
          <div className={glassCard}>
            <label className="block text-sm font-medium text-[#e6f2ee] mb-2">
              What would you like to build?
            </label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe a feature, bug fix, or task..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-[#0e1a17] border border-[rgba(34,197,94,0.12)] text-[#e6f2ee] text-sm placeholder:text-[#9fb7ae]/40 focus:outline-none focus:border-green-500/40 resize-none"
            />
            <div className="mt-3">
              <p className="text-xs text-[#9fb7ae]/60 mb-2">Try one of these:</p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => setTask(s)}
                    className="text-[11px] px-2 py-1 rounded-md bg-[rgba(34,197,94,0.06)] border border-[rgba(34,197,94,0.1)] text-[#9fb7ae] hover:text-[#e6f2ee] hover:border-[rgba(34,197,94,0.2)] transition-all cursor-pointer"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button onClick={onBack} className={btnGhost}>
              <ArrowLeft size={16} /> Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={!task}
              className={`${btnPrimary} ${!task ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <Play size={16} /> Start task
            </button>
          </div>
        </>
      ) : (
        <div className={glassCard}>
          <div className="text-center mb-4">
            {progress < 100 ? (
              <Loader2 size={32} className="text-green-400 mx-auto mb-3 animate-spin" />
            ) : (
              <Check size={32} className="text-green-400 mx-auto mb-3" />
            )}
            <p className="font-semibold text-[#e6f2ee]">
              {progress < 25
                ? 'Creating workspace...'
                : progress < 50
                  ? 'Cloning your repository...'
                  : progress < 75
                    ? 'Installing dependencies...'
                    : progress < 100
                      ? 'Starting AI agent...'
                      : 'Agent is working!'}
            </p>
          </div>

          {/* Progress steps */}
          <div className="space-y-2 mb-4">
            {[
              { label: 'Provisioning VM', threshold: 0 },
              { label: 'Cloning repository', threshold: 25 },
              { label: 'Building devcontainer', threshold: 50 },
              { label: 'Starting Claude Code', threshold: 75 },
            ].map((step, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                {progress > step.threshold + 20 ? (
                  <Check size={14} className="text-green-400" />
                ) : progress > step.threshold ? (
                  <Loader2 size={14} className="text-green-400 animate-spin" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border border-[rgba(34,197,94,0.2)]" />
                )}
                <span
                  className={
                    progress > step.threshold ? 'text-[#e6f2ee]' : 'text-[#9fb7ae]/50'
                  }
                >
                  {step.label}
                </span>
              </div>
            ))}
          </div>

          {progress >= 100 && (
            <div className={`${infoBox} mt-4`}>
              <p className="text-green-400 font-medium mb-1 flex items-center gap-2">
                <Sparkles size={14} /> You're up and running!
              </p>
              <p className="text-xs">
                Your agent is now working on "{task}" in a real dev environment. You can watch it
                work in the chat, or come back later — SAM will notify you when it opens a PR.
              </p>
              <div className="flex gap-2 mt-3">
                <button className={btnPrimary}>
                  <MessageSquare size={14} /> Watch agent work
                </button>
                <button className={btnGhost}>
                  Go to dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Main Prototype Component ─── */
export function PrototypeZeroToHero() {
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedAgent, setSelectedAgent] = useState<MockAgent | null>(null);
  const [selectedMode, setSelectedMode] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);

  const step = WALKTHROUGH_STEPS[stepIndex];
  const goNext = useCallback(() => setStepIndex((i) => Math.min(i + 1, WALKTHROUGH_STEPS.length - 1)), []);
  const goBack = useCallback(() => setStepIndex((i) => Math.max(i - 1, 0)), []);

  return (
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      className="bg-[#0b1110] text-[#e6f2ee]"
    >
      {/* Header */}
      <div className="sticky top-0 z-50 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-b border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-md bg-green-500/20 flex items-center justify-center text-green-400 text-xs font-bold">
                S
              </div>
              <span className="text-sm font-semibold text-[#e6f2ee]">{step.title}</span>
            </div>
            <span className="text-xs text-[#9fb7ae]/60">{step.subtitle}</span>
          </div>
          <ProgressBar current={stepIndex} total={WALKTHROUGH_STEPS.length} />
        </div>
      </div>

      {/* Content */}
      <div className="max-w-2xl mx-auto px-4 py-8">
        {step.id === 'welcome' && <WelcomeStep onNext={goNext} />}
        {step.id === 'concept' && <ConceptStep onNext={goNext} onBack={goBack} />}
        {step.id === 'agent' && (
          <AgentStep
            onNext={goNext}
            onBack={goBack}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
          />
        )}
        {step.id === 'billing' && (
          <BillingStep
            onNext={goNext}
            onBack={goBack}
            selectedAgent={selectedAgent}
            selectedMode={selectedMode}
            onSelectMode={setSelectedMode}
          />
        )}
        {step.id === 'cloud' && (
          <CloudStep
            onNext={goNext}
            onBack={goBack}
            selectedProvider={selectedProvider}
            onSelectProvider={setSelectedProvider}
          />
        )}
        {step.id === 'github' && (
          <GitHubStep
            onNext={goNext}
            onBack={goBack}
            connected={githubConnected}
            onConnect={() => setGithubConnected(true)}
          />
        )}
        {step.id === 'first-task' && <FirstTaskStep onBack={goBack} />}
      </div>

      {/* Footer */}
      <div className="fixed bottom-0 left-0 right-0 bg-[rgba(8,15,12,0.85)] backdrop-blur-xl border-t border-[rgba(34,197,94,0.08)]">
        <div className="max-w-2xl mx-auto px-4 py-2 flex justify-between items-center">
          <span className="text-[10px] text-[#9fb7ae]/40">PROTOTYPE — Zero-to-Hero Onboarding</span>
          <div className="flex gap-1">
            {WALKTHROUGH_STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStepIndex(i)}
                className={`w-2 h-2 rounded-full cursor-pointer border-none transition-all ${
                  i === stepIndex
                    ? 'bg-green-400 w-4'
                    : i < stepIndex
                      ? 'bg-green-400/30'
                      : 'bg-[rgba(34,197,94,0.1)]'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
