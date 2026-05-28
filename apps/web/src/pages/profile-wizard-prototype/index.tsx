import {
  Check,
  ChevronRight,
  MessageSquare,
  Monitor,
  Pencil,
  Plus,
  Send,
  Settings,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react';
import { useState } from 'react';

import type { MockAgent, MockProfile, MockVmSize } from './mock-data';
import {
  EXISTING_PROFILES,
  MULTIPLE_AGENTS,
  SINGLE_AGENT,
  VM_SIZES,
} from './mock-data';

/* ------------------------------------------------------------------ */
/*  Scenario selector — toggle between demo states                     */
/* ------------------------------------------------------------------ */

type Scenario = 'single-no-profiles' | 'multi-no-profiles' | 'has-profiles';

const SCENARIOS: { key: Scenario; label: string; description: string }[] = [
  {
    key: 'single-no-profiles',
    label: '1 agent, no profiles',
    description: 'Auto-default — user just types',
  },
  {
    key: 'multi-no-profiles',
    label: 'Multiple agents, no profiles',
    description: 'Wizard required before first message',
  },
  {
    key: 'has-profiles',
    label: 'Has profiles',
    description: 'Normal state — profile selector',
  },
];

/* ------------------------------------------------------------------ */
/*  Main prototype page                                                */
/* ------------------------------------------------------------------ */

export function ProfileWizardPrototype() {
  const [scenario, setScenario] = useState<Scenario>('single-no-profiles');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [profiles, setProfiles] = useState<MockProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [messageValue, setMessageValue] = useState('');

  const agents = scenario === 'multi-no-profiles' || scenario === 'has-profiles'
    ? MULTIPLE_AGENTS
    : SINGLE_AGENT;

  const activeProfiles = scenario === 'has-profiles' ? EXISTING_PROFILES : profiles;

  const handleScenarioChange = (s: Scenario) => {
    setScenario(s);
    setProfiles([]);
    setSelectedProfileId(null);
    setWizardOpen(false);
    setMessageValue('');
  };

  const handleProfileCreated = (profile: MockProfile) => {
    setProfiles((prev) => [...prev, profile]);
    setSelectedProfileId(profile.id);
    setWizardOpen(false);
  };

  const handleSend = () => {
    if (!messageValue.trim()) return;
    // In prototype, just clear + flash a confirmation
    setMessageValue('');
  };

  // Determine what to render in the chat input area
  const hasProfiles = activeProfiles.length > 0;
  const needsWizard = !hasProfiles && agents.length > 1;
  const autoDefault = !hasProfiles && agents.length === 1;

  return (
    <div style={{ height: '100vh', overflow: 'auto', background: 'var(--bg-page, #0a0a0a)' }}>
      {/* Scenario switcher bar */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'var(--bg-elevated, #1a1a1a)',
        borderBottom: '1px solid var(--border-default, #333)',
        padding: '12px 16px',
      }}>
        <div style={{ fontSize: '11px', color: 'var(--fg-muted, #888)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Prototype: Profile Setup Wizard
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SCENARIOS.map((s) => (
            <button
              key={s.key}
              onClick={() => handleScenarioChange(s.key)}
              style={{
                padding: '6px 12px',
                borderRadius: 6,
                border: scenario === s.key ? '1px solid var(--color-accent, #22c55e)' : '1px solid var(--border-default, #333)',
                background: scenario === s.key ? 'rgba(34,197,94,0.1)' : 'transparent',
                color: scenario === s.key ? 'var(--color-accent, #22c55e)' : 'var(--fg-secondary, #aaa)',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              <div style={{ fontWeight: 500 }}>{s.label}</div>
              <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{s.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Simulated project chat page */}
      <div style={{
        maxWidth: 720,
        margin: '0 auto',
        height: 'calc(100vh - 90px)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Chat messages area (empty state) */}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        }}>
          <div style={{ textAlign: 'center', color: 'var(--fg-muted, #666)' }}>
            <MessageSquare size={40} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
            <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--fg-secondary, #aaa)' }}>
              Start a conversation
            </div>
            <div style={{ fontSize: 13, marginTop: 4 }}>
              {autoDefault && 'Just type your message below to get started.'}
              {needsWizard && !wizardOpen && 'Create a profile to configure how your agent works.'}
              {needsWizard && wizardOpen && 'Set up your profile, then send your first message.'}
              {hasProfiles && 'Select a profile and type your message.'}
            </div>
          </div>
        </div>

        {/* Bottom input area */}
        <div style={{
          borderTop: '1px solid var(--border-default, #222)',
          background: 'var(--bg-elevated, #111)',
          padding: 16,
        }}>
          {/* Wizard overlay for multi-agent, no profiles */}
          {needsWizard && !wizardOpen && (
            <NoProfilesGate onStartWizard={() => setWizardOpen(true)} />
          )}

          {needsWizard && wizardOpen && (
            <ProfileWizard
              agents={agents}
              onComplete={handleProfileCreated}
              onCancel={() => setWizardOpen(false)}
            />
          )}

          {/* Auto-default banner for single agent */}
          {autoDefault && (
            <AutoDefaultBanner agent={agents[0]} />
          )}

          {/* Normal profile selector when profiles exist */}
          {hasProfiles && (
            <ProfileBar
              profiles={activeProfiles}
              selectedProfileId={selectedProfileId}
              onSelect={setSelectedProfileId}
              onNewProfile={() => setWizardOpen(true)}
            />
          )}

          {/* Message input — always visible, disabled when wizard needed */}
          <MessageInput
            value={messageValue}
            onChange={setMessageValue}
            onSend={handleSend}
            disabled={needsWizard}
            placeholder={
              needsWizard
                ? 'Create a profile to start chatting...'
                : autoDefault
                  ? 'Ask anything... (using defaults: medium VM, lightweight workspace)'
                  : 'Ask anything...'
            }
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  No profiles gate — shown when wizard needed but not yet started    */
/* ------------------------------------------------------------------ */

function NoProfilesGate({ onStartWizard }: { onStartWizard: () => void }) {
  return (
    <div style={{
      background: 'rgba(34,197,94,0.05)',
      border: '1px solid rgba(34,197,94,0.2)',
      borderRadius: 10,
      padding: 16,
      marginBottom: 12,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
    }}>
      <div style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        background: 'rgba(34,197,94,0.1)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Sparkles size={20} style={{ color: 'var(--color-accent, #22c55e)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg-primary, #eee)' }}>
          Set up your first profile
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted, #888)', marginTop: 2 }}>
          A profile configures which agent to use and how it runs. Takes about 30 seconds.
        </div>
      </div>
      <button
        onClick={onStartWizard}
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          border: 'none',
          background: 'var(--color-accent, #22c55e)',
          color: '#000',
          fontWeight: 600,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flexShrink: 0,
        }}
      >
        Create profile
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Auto-default banner — single agent, no profiles, just go          */
/* ------------------------------------------------------------------ */

function AutoDefaultBanner({ agent }: { agent: MockAgent }) {
  return (
    <div style={{
      background: 'rgba(34,197,94,0.05)',
      border: '1px solid rgba(34,197,94,0.15)',
      borderRadius: 8,
      padding: '8px 12px',
      marginBottom: 10,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 12,
      color: 'var(--fg-muted, #888)',
    }}>
      <Zap size={14} style={{ color: 'var(--color-accent, #22c55e)', flexShrink: 0 }} />
      <span>
        Using <strong style={{ color: 'var(--fg-primary, #ddd)' }}>{agent.name}</strong> with
        default settings (medium VM, lightweight workspace).
        <button
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-accent, #22c55e)',
            cursor: 'pointer',
            padding: '0 4px',
            fontSize: 12,
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
        >
          Customize
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile bar — normal state when profiles exist                     */
/* ------------------------------------------------------------------ */

function ProfileBar({
  profiles,
  selectedProfileId,
  onSelect,
  onNewProfile,
}: {
  profiles: MockProfile[];
  selectedProfileId: string | null;
  onSelect: (id: string | null) => void;
  onNewProfile: () => void;
}) {
  const selected = selectedProfileId ?? profiles[0]?.id ?? null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
      flexWrap: 'wrap',
    }}>
      {profiles.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          style={{
            padding: '5px 12px',
            borderRadius: 20,
            border: selected === p.id
              ? '1px solid var(--color-accent, #22c55e)'
              : '1px solid var(--border-default, #333)',
            background: selected === p.id
              ? 'rgba(34,197,94,0.1)'
              : 'transparent',
            color: selected === p.id
              ? 'var(--color-accent, #22c55e)'
              : 'var(--fg-secondary, #aaa)',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {p.name}
          {selected === p.id && (
            <Settings size={12} style={{ opacity: 0.6 }} />
          )}
        </button>
      ))}
      <button
        onClick={onNewProfile}
        style={{
          padding: '5px 10px',
          borderRadius: 20,
          border: '1px dashed var(--border-default, #333)',
          background: 'transparent',
          color: 'var(--fg-muted, #666)',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <Plus size={12} />
        New
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Profile wizard — multi-step creation flow                          */
/* ------------------------------------------------------------------ */

type WizardStep = 'agent' | 'work-type' | 'vm-size' | 'name';

function ProfileWizard({
  agents,
  onComplete,
  onCancel,
}: {
  agents: MockAgent[];
  onComplete: (profile: MockProfile) => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<WizardStep>('agent');
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [workType, setWorkType] = useState<'task' | 'conversation' | null>(null);
  const [vmSize, setVmSize] = useState<MockVmSize['key'] | null>(null);
  const [profileName, setProfileName] = useState('');

  const agentObj = agents.find((a) => a.id === selectedAgent);

  const handleNext = () => {
    if (step === 'agent' && selectedAgent) setStep('work-type');
    else if (step === 'work-type' && workType) setStep('vm-size');
    else if (step === 'vm-size' && vmSize) {
      // Auto-suggest a name
      const suggestedName = workType === 'task'
        ? `${agentObj?.name ?? 'Agent'} — Implementer`
        : `${agentObj?.name ?? 'Agent'} — Chat`;
      setProfileName(suggestedName);
      setStep('name');
    } else if (step === 'name' && profileName.trim()) {
      onComplete({
        id: `p-${Date.now()}`,
        name: profileName.trim(),
        agentType: selectedAgent!,
        vmSize: vmSize!,
        workspaceProfile: workType === 'task' ? 'full' : 'lightweight',
        taskMode: workType!,
        description: workType === 'task' ? 'Write code and open PRs' : 'Chat and explore',
      });
    }
  };

  const canProceed =
    (step === 'agent' && !!selectedAgent) ||
    (step === 'work-type' && !!workType) ||
    (step === 'vm-size' && !!vmSize) ||
    (step === 'name' && !!profileName.trim());

  const stepIndex = ['agent', 'work-type', 'vm-size', 'name'].indexOf(step);

  return (
    <div style={{
      background: 'var(--bg-surface, #161616)',
      border: '1px solid var(--border-default, #333)',
      borderRadius: 12,
      marginBottom: 12,
      overflow: 'hidden',
    }}>
      {/* Progress bar */}
      <div style={{
        height: 3,
        background: 'var(--border-default, #222)',
      }}>
        <div style={{
          height: '100%',
          width: `${((stepIndex + 1) / 4) * 100}%`,
          background: 'var(--color-accent, #22c55e)',
          transition: 'width 0.3s ease',
        }} />
      </div>

      <div style={{ padding: 16 }}>
        {/* Step 1: Choose agent */}
        {step === 'agent' && (
          <WizardStepLayout
            stepNumber={1}
            totalSteps={4}
            title="Which agent should run your tasks?"
            subtitle="Each agent has different strengths. You can always create more profiles later."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={selectedAgent === agent.id}
                  onClick={() => setSelectedAgent(agent.id)}
                />
              ))}
            </div>
          </WizardStepLayout>
        )}

        {/* Step 2: What kind of work */}
        {step === 'work-type' && (
          <WizardStepLayout
            stepNumber={2}
            totalSteps={4}
            title="What kind of work?"
            subtitle="This configures the workspace environment. You can change it per-session later."
          >
            <div style={{ display: 'flex', gap: 10 }}>
              <WorkTypeCard
                icon={<Wrench size={20} />}
                title="Write code & open PRs"
                description="Full dev environment with git. Agent works autonomously, pushes changes, creates PRs."
                selected={workType === 'task'}
                onClick={() => setWorkType('task')}
                tag="Task mode"
              />
              <WorkTypeCard
                icon={<MessageSquare size={20} />}
                title="Chat & explore"
                description="Lightweight workspace. Ask questions, explore code, brainstorm ideas together."
                selected={workType === 'conversation'}
                onClick={() => setWorkType('conversation')}
                tag="Conversation mode"
              />
            </div>
          </WizardStepLayout>
        )}

        {/* Step 3: VM size */}
        {step === 'vm-size' && (
          <WizardStepLayout
            stepNumber={3}
            totalSteps={4}
            title="How powerful should the machine be?"
            subtitle="Bigger machines handle heavier builds. You only pay while the workspace is running."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {VM_SIZES.map((size) => (
                <VmSizeCard
                  key={size.key}
                  size={size}
                  selected={vmSize === size.key}
                  recommended={size.key === 'medium'}
                  onClick={() => setVmSize(size.key)}
                />
              ))}
            </div>
          </WizardStepLayout>
        )}

        {/* Step 4: Name */}
        {step === 'name' && (
          <WizardStepLayout
            stepNumber={4}
            totalSteps={4}
            title="Name this profile"
            subtitle="Give it a short name so you can pick it quickly later."
          >
            <div>
              <input
                type="text"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="e.g. Implementer, Quick Chat, Reviewer..."
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && canProceed) handleNext(); }}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border-default, #333)',
                  background: 'var(--bg-page, #0a0a0a)',
                  color: 'var(--fg-primary, #eee)',
                  fontSize: 14,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              <div style={{ fontSize: 11, color: 'var(--fg-muted, #666)', marginTop: 8 }}>
                Summary: <strong>{agentObj?.name}</strong> &middot;{' '}
                {workType === 'task' ? 'Task mode (full workspace)' : 'Conversation (lightweight)'} &middot;{' '}
                {vmSize?.charAt(0).toUpperCase()}{vmSize?.slice(1)} VM
              </div>
            </div>
          </WizardStepLayout>
        )}

        {/* Navigation */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px solid var(--border-default, #222)',
        }}>
          <button
            onClick={() => {
              if (step === 'agent') onCancel();
              else if (step === 'work-type') setStep('agent');
              else if (step === 'vm-size') setStep('work-type');
              else if (step === 'name') setStep('vm-size');
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--border-default, #333)',
              background: 'transparent',
              color: 'var(--fg-muted, #888)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {step === 'agent' ? 'Cancel' : 'Back'}
          </button>
          <button
            onClick={handleNext}
            disabled={!canProceed}
            style={{
              padding: '6px 16px',
              borderRadius: 6,
              border: 'none',
              background: canProceed ? 'var(--color-accent, #22c55e)' : 'var(--border-default, #333)',
              color: canProceed ? '#000' : 'var(--fg-muted, #666)',
              fontWeight: 600,
              cursor: canProceed ? 'pointer' : 'default',
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            {step === 'name' ? (
              <>
                <Check size={14} />
                Create profile
              </>
            ) : (
              <>
                Next
                <ChevronRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Wizard sub-components                                              */
/* ------------------------------------------------------------------ */

function WizardStepLayout({
  stepNumber,
  totalSteps,
  title,
  subtitle,
  children,
}: {
  stepNumber: number;
  totalSteps: number;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{
        fontSize: 10,
        color: 'var(--fg-muted, #666)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 4,
      }}>
        Step {stepNumber} of {totalSteps}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg-primary, #eee)', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted, #888)', marginBottom: 14 }}>
        {subtitle}
      </div>
      {children}
    </div>
  );
}

function AgentCard({
  agent,
  selected,
  onClick,
}: {
  agent: MockAgent;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: 12,
        borderRadius: 10,
        border: selected
          ? '1.5px solid var(--color-accent, #22c55e)'
          : '1px solid var(--border-default, #333)',
        background: selected ? 'rgba(34,197,94,0.06)' : 'var(--bg-page, #0a0a0a)',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'all 0.15s ease',
      }}
    >
      <div style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: selected ? 'rgba(34,197,94,0.15)' : 'var(--bg-elevated, #1a1a1a)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: 16,
        color: selected ? 'var(--color-accent, #22c55e)' : 'var(--fg-muted, #888)',
        flexShrink: 0,
      }}>
        {agent.icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: selected ? 'var(--fg-primary, #eee)' : 'var(--fg-secondary, #aaa)',
        }}>
          {agent.name}
        </div>
        <div style={{
          fontSize: 11,
          color: 'var(--fg-muted, #777)',
          marginTop: 2,
          lineHeight: 1.3,
        }}>
          {agent.description}
        </div>
      </div>
      {selected && (
        <Check size={16} style={{ color: 'var(--color-accent, #22c55e)', flexShrink: 0 }} />
      )}
    </button>
  );
}

function WorkTypeCard({
  icon,
  title,
  description,
  tag,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tag: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: 14,
        borderRadius: 10,
        border: selected
          ? '1.5px solid var(--color-accent, #22c55e)'
          : '1px solid var(--border-default, #333)',
        background: selected ? 'rgba(34,197,94,0.06)' : 'var(--bg-page, #0a0a0a)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'all 0.15s ease',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{
        color: selected ? 'var(--color-accent, #22c55e)' : 'var(--fg-muted, #888)',
      }}>
        {icon}
      </div>
      <div>
        <div style={{
          fontSize: 13,
          fontWeight: 600,
          color: selected ? 'var(--fg-primary, #eee)' : 'var(--fg-secondary, #aaa)',
        }}>
          {title}
        </div>
        <div style={{
          fontSize: 11,
          color: 'var(--fg-muted, #777)',
          marginTop: 4,
          lineHeight: 1.4,
        }}>
          {description}
        </div>
      </div>
      <div style={{
        fontSize: 10,
        color: 'var(--fg-muted, #666)',
        background: 'var(--bg-elevated, #1a1a1a)',
        padding: '2px 8px',
        borderRadius: 4,
        alignSelf: 'flex-start',
        marginTop: 'auto',
      }}>
        {tag}
      </div>
    </button>
  );
}

function VmSizeCard({
  size,
  selected,
  recommended,
  onClick,
}: {
  size: MockVmSize;
  selected: boolean;
  recommended: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        borderRadius: 10,
        border: selected
          ? '1.5px solid var(--color-accent, #22c55e)'
          : '1px solid var(--border-default, #333)',
        background: selected ? 'rgba(34,197,94,0.06)' : 'var(--bg-page, #0a0a0a)',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'all 0.15s ease',
      }}
    >
      <div style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        background: selected ? 'rgba(34,197,94,0.15)' : 'var(--bg-elevated, #1a1a1a)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Monitor size={16} style={{
          color: selected ? 'var(--color-accent, #22c55e)' : 'var(--fg-muted, #888)',
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 13,
            fontWeight: 600,
            color: selected ? 'var(--fg-primary, #eee)' : 'var(--fg-secondary, #aaa)',
          }}>
            {size.label}
          </span>
          {recommended && (
            <span style={{
              fontSize: 9,
              fontWeight: 600,
              color: 'var(--color-accent, #22c55e)',
              background: 'rgba(34,197,94,0.1)',
              padding: '1px 6px',
              borderRadius: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}>
              Recommended
            </span>
          )}
        </div>
        <div style={{
          fontSize: 11,
          color: 'var(--fg-muted, #777)',
          marginTop: 2,
        }}>
          {size.description} &middot; {size.specs}
        </div>
      </div>
      <div style={{
        fontSize: 11,
        color: 'var(--fg-muted, #666)',
        flexShrink: 0,
      }}>
        {size.pricePerHour}
      </div>
      {selected && (
        <Check size={16} style={{ color: 'var(--color-accent, #22c55e)', flexShrink: 0 }} />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Message input                                                      */
/* ------------------------------------------------------------------ */

function MessageInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-end',
      gap: 8,
      opacity: disabled ? 0.5 : 1,
      transition: 'opacity 0.2s ease',
    }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !disabled) {
            e.preventDefault();
            onSend();
          }
        }}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        style={{
          flex: 1,
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid var(--border-default, #333)',
          background: 'var(--bg-page, #0a0a0a)',
          color: 'var(--fg-primary, #eee)',
          fontSize: 14,
          resize: 'none',
          outline: 'none',
          minHeight: 42,
          maxHeight: 120,
          lineHeight: 1.5,
          fontFamily: 'inherit',
        }}
      />
      <button
        onClick={onSend}
        disabled={disabled || !value.trim()}
        style={{
          width: 42,
          height: 42,
          borderRadius: 10,
          border: 'none',
          background: !disabled && value.trim()
            ? 'var(--color-accent, #22c55e)'
            : 'var(--border-default, #333)',
          color: !disabled && value.trim() ? '#000' : 'var(--fg-muted, #666)',
          cursor: !disabled && value.trim() ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'all 0.15s ease',
        }}
      >
        <Send size={18} />
      </button>
    </div>
  );
}
