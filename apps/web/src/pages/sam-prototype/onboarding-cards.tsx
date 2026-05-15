/**
 * Interactive onboarding card components rendered inline in SAM chat.
 *
 * These are triggered by special ```onboarding-card code blocks in the
 * agent's markdown output. The SamMarkdown renderer detects the language
 * tag and delegates to this module.
 */
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  Key,
  PartyPopper,
  Rocket,
  Server,
  Sparkles,
} from 'lucide-react';
import type { FC } from 'react';
import { useCallback, useEffect, useState } from 'react';

/* ===================================================================
   Shared styles — glassmorphism from Prototype B
   =================================================================== */

const cardBase: React.CSSProperties = {
  background: 'rgba(19, 32, 29, 0.85)',
  border: '1px solid rgba(60, 180, 120, 0.2)',
  borderRadius: '20px',
  padding: '24px 20px',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  boxShadow:
    '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 60px rgba(22, 163, 74, 0.08)',
};

const buttonPrimary: React.CSSProperties = {
  background: 'rgba(60, 180, 120, 0.25)',
  border: '1px solid rgba(60, 180, 120, 0.4)',
  borderRadius: '12px',
  padding: '10px 20px',
  color: 'rgba(120, 220, 170, 0.95)',
  fontWeight: 600,
  fontSize: '0.875rem',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  boxShadow: '0 0 20px rgba(60, 180, 120, 0.15)',
};

/* ===================================================================
   Card type definitions
   =================================================================== */

interface WelcomeCardData {
  type: 'welcome';
  title: string;
  message: string;
}

interface SetupChecklistData {
  type: 'setup-checklist';
  steps: Array<{
    key: string;
    label: string;
    done: boolean;
  }>;
}

interface ActionCardData {
  type: 'action';
  title: string;
  message: string;
  action: 'navigate' | 'link';
  href: string;
  buttonLabel: string;
}

interface CelebrationCardData {
  type: 'celebration';
  title: string;
  message: string;
}

type OnboardingCardData =
  | WelcomeCardData
  | SetupChecklistData
  | ActionCardData
  | CelebrationCardData;

/* ===================================================================
   Welcome Card
   =================================================================== */

const WelcomeCard: FC<{ data: WelcomeCardData }> = ({ data }) => (
  <div style={cardBase} className="my-3">
    <div className="flex items-start gap-3 mb-3">
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
        style={{
          background: 'rgba(60, 180, 120, 0.15)',
          boxShadow: '0 0 20px rgba(60, 180, 120, 0.2)',
        }}
      >
        <Sparkles className="w-5 h-5" style={{ color: '#3cb480' }} />
      </div>
      <div>
        <h3
          className="text-base font-semibold mb-1"
          style={{ color: 'rgba(255, 255, 255, 0.95)' }}
        >
          {data.title}
        </h3>
        <p
          className="text-sm leading-relaxed"
          style={{ color: 'rgba(255, 255, 255, 0.6)' }}
        >
          {data.message}
        </p>
      </div>
    </div>
  </div>
);

/* ===================================================================
   Setup Checklist Card
   =================================================================== */

const stepIcons: Record<string, FC<{ className?: string; style?: React.CSSProperties }>> = {
  cloud_provider: Server,
  agent_key: Key,
  github_app: Rocket,
  project: Rocket,
};

const SetupChecklistCard: FC<{ data: SetupChecklistData }> = ({ data }) => {
  const completed = data.steps.filter((s) => s.done).length;
  const total = data.steps.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;

  return (
    <div style={cardBase} className="my-3">
      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between items-center mb-2">
          <span
            className="text-xs font-medium"
            style={{ color: 'rgba(255, 255, 255, 0.5)' }}
          >
            Setup progress
          </span>
          <span
            className="text-xs font-semibold"
            style={{ color: '#3cb480' }}
          >
            {completed}/{total}
          </span>
        </div>
        <div
          style={{
            height: '4px',
            borderRadius: '2px',
            background: 'rgba(60, 180, 120, 0.1)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              borderRadius: '2px',
              background: 'linear-gradient(90deg, rgba(60, 180, 120, 0.6), rgba(60, 180, 120, 0.9))',
              boxShadow: '0 0 8px rgba(60, 180, 120, 0.4)',
              transition: 'width 0.6s ease',
            }}
          />
        </div>
      </div>

      {/* Steps */}
      <div className="space-y-2.5">
        {data.steps.map((step) => {
          const IconComponent = stepIcons[step.key] || Circle;
          return (
            <div
              key={step.key}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors"
              style={{
                background: step.done
                  ? 'rgba(60, 180, 120, 0.08)'
                  : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${step.done ? 'rgba(60, 180, 120, 0.15)' : 'rgba(255, 255, 255, 0.05)'}`,
              }}
            >
              {step.done ? (
                <CheckCircle2
                  className="w-4.5 h-4.5 shrink-0"
                  style={{ color: '#3cb480' }}
                />
              ) : (
                <IconComponent
                  className="w-4.5 h-4.5 shrink-0"
                  style={{ color: 'rgba(255, 255, 255, 0.3)' }}
                />
              )}
              <span
                className="text-sm"
                style={{
                  color: step.done
                    ? 'rgba(120, 220, 170, 0.9)'
                    : 'rgba(255, 255, 255, 0.6)',
                  textDecoration: step.done ? 'line-through' : 'none',
                }}
              >
                {step.label}
              </span>
              {step.done && (
                <Check
                  className="w-3.5 h-3.5 ml-auto shrink-0"
                  style={{ color: 'rgba(60, 180, 120, 0.5)' }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ===================================================================
   Action Card (navigate to settings, etc.)
   =================================================================== */

const ActionCard: FC<{ data: ActionCardData }> = ({ data }) => {
  const handleClick = useCallback(() => {
    if (data.action === 'navigate') {
      window.location.href = data.href;
    } else {
      window.open(data.href, '_blank', 'noopener,noreferrer');
    }
  }, [data.action, data.href]);

  return (
    <div style={cardBase} className="my-3">
      <h3
        className="text-sm font-semibold mb-1.5"
        style={{ color: 'rgba(255, 255, 255, 0.95)' }}
      >
        {data.title}
      </h3>
      <p
        className="text-sm mb-4 leading-relaxed"
        style={{ color: 'rgba(255, 255, 255, 0.55)' }}
      >
        {data.message}
      </p>
      <button type="button" style={buttonPrimary} onClick={handleClick}>
        {data.buttonLabel}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
};

/* ===================================================================
   Celebration Card
   =================================================================== */

const CelebrationCard: FC<{ data: CelebrationCardData }> = ({ data }) => {
  const [showConfetti, setShowConfetti] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowConfetti(true), 200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      style={{
        ...cardBase,
        border: '1px solid rgba(60, 180, 120, 0.3)',
        boxShadow:
          '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 80px rgba(22, 163, 74, 0.15)',
      }}
      className="my-3 relative overflow-hidden"
    >
      {/* Breathing glow effect */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(60, 180, 120, 0.08), transparent 70%)',
          animation: showConfetti ? 'celebration-breathe 3s ease-in-out infinite' : 'none',
        }}
      />
      <div className="relative flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
          style={{
            background: 'rgba(60, 180, 120, 0.2)',
            boxShadow: '0 0 24px rgba(60, 180, 120, 0.3)',
          }}
        >
          <PartyPopper className="w-5 h-5" style={{ color: '#3cb480' }} />
        </div>
        <div>
          <h3
            className="text-base font-semibold mb-1"
            style={{ color: 'rgba(120, 220, 170, 0.95)' }}
          >
            {data.title}
          </h3>
          <p
            className="text-sm leading-relaxed"
            style={{ color: 'rgba(255, 255, 255, 0.6)' }}
          >
            {data.message}
          </p>
        </div>
      </div>
    </div>
  );
};

/* ===================================================================
   Main renderer — parses JSON and dispatches to the right card
   =================================================================== */

export function renderOnboardingCard(json: string): React.ReactNode {
  try {
    const data = JSON.parse(json) as OnboardingCardData;
    switch (data.type) {
      case 'welcome':
        return <WelcomeCard data={data} />;
      case 'setup-checklist':
        return <SetupChecklistCard data={data} />;
      case 'action':
        return <ActionCard data={data} />;
      case 'celebration':
        return <CelebrationCard data={data} />;
      default:
        return null;
    }
  } catch {
    return null;
  }
}
