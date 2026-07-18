import {
  Bot,
  Box,
  Check,
  ChevronDown,
  Clock,
  Cloud,
  Github,
  Info,
  type LucideIcon,
  MessageSquare,
  Rocket,
} from 'lucide-react';
import type { ReactNode } from 'react';

/* ─────────────────────────── Step model ─────────────────────────── */

export type OnboardingStepId =
  | 'welcome'
  | 'how-sam-works'
  | 'provider'
  | 'connect'
  | 'conversation'
  | 'task'
  | 'automation'
  | 'kickoff';

export interface OnboardingStepMeta {
  id: OnboardingStepId;
  label: string;
  icon: LucideIcon;
}

export const ONBOARDING_STEPS: OnboardingStepMeta[] = [
  { id: 'welcome', label: 'Welcome', icon: Rocket },
  { id: 'how-sam-works', label: 'How SAM works', icon: Box },
  { id: 'provider', label: 'Where code lives', icon: Cloud },
  { id: 'connect', label: 'Connect code', icon: Github },
  { id: 'conversation', label: 'Conversation agent', icon: MessageSquare },
  { id: 'task', label: 'Task agent', icon: Bot },
  { id: 'automation', label: 'Automation', icon: Clock },
  { id: 'kickoff', label: 'Kick off', icon: Rocket },
];

export function stepIndex(id: OnboardingStepId): number {
  return ONBOARDING_STEPS.findIndex((s) => s.id === id);
}

/* ─────────────────────────── Presentational ─────────────────────────── */

/**
 * The signature "why" disclosure, modeled on the marketing self-host page's
 * `<details class="sh-why">`: an info icon, a question, and an expand chevron
 * that reveals extra context for readers who want it.
 */
export function WhyDetails({
  question,
  children,
}: Readonly<{ question: string; children: ReactNode }>) {
  return (
    <details className="group rounded-md border border-border-default bg-inset/60 [&_svg.why-chevron]:open:rotate-180">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm text-fg-secondary [&::-webkit-details-marker]:hidden">
        <Info size={16} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="flex-1">{question}</span>
        <ChevronDown
          size={16}
          className="why-chevron shrink-0 text-fg-muted transition-transform"
          aria-hidden="true"
        />
      </summary>
      <div className="grid gap-2 border-t border-border-default px-3 py-3 text-sm leading-relaxed text-fg-muted">
        {children}
      </div>
    </details>
  );
}

export function Callout({
  variant,
  children,
}: Readonly<{ variant: 'info' | 'warn'; children: ReactNode }>) {
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
export function StepHeader({
  id,
  title,
  lead,
}: Readonly<{ id: OnboardingStepId; title: string; lead: ReactNode }>) {
  const index = stepIndex(id);
  return (
    <div className="grid gap-2">
      {/* Hidden on mobile — MobileProgress already shows "Step N of M" right above. */}
      <span className="hidden lg:block text-xs font-semibold uppercase tracking-wider text-accent">
        Step {index + 1} of {ONBOARDING_STEPS.length}
      </span>
      <h2 className="text-xl font-semibold text-fg-primary">{title}</h2>
      <p className="text-sm leading-relaxed text-fg-muted">{lead}</p>
    </div>
  );
}

/** A small "icon + title + body" info card used across intro steps. */
export function InfoCard({
  icon: Icon,
  title,
  body,
}: Readonly<{ icon: LucideIcon; title: string; body: ReactNode }>) {
  return (
    <div className="grid gap-1.5 rounded-md border border-border-default bg-surface p-3">
      <Icon size={18} className="text-accent" aria-hidden="true" />
      <span className="text-sm font-semibold text-fg-primary">{title}</span>
      <span className="text-xs text-fg-muted">{body}</span>
    </div>
  );
}

type RailState = 'complete' | 'current' | 'upcoming';

function railState(index: number, currentIndex: number): RailState {
  if (index < currentIndex) return 'complete';
  if (index === currentIndex) return 'current';
  return 'upcoming';
}

function railButtonClass(state: RailState, locked: boolean): string {
  if (state === 'current') return 'bg-accent/10 text-fg-primary';
  if (locked) return 'cursor-default text-fg-muted';
  return 'text-fg-muted hover:bg-surface-hover';
}

function railBadgeClass(state: RailState): string {
  if (state === 'complete') return 'border-success/50 bg-success-tint text-fg-primary';
  if (state === 'current') return 'border-accent text-fg-primary';
  return 'border-border-default text-fg-muted';
}

/**
 * Left-hand progress rail (desktop). Steps at an index below `lockedBeforeIndex`
 * are shown complete and are not clickable — used to stop the user from jumping
 * back to project-creation steps after the project already exists.
 */
export function ProgressRail({
  current,
  lockedBeforeIndex = 0,
  onJump,
}: Readonly<{
  current: OnboardingStepId;
  lockedBeforeIndex?: number;
  onJump: (id: OnboardingStepId) => void;
}>) {
  const currentIndex = stepIndex(current);
  return (
    <ol className="grid gap-1" aria-label="Onboarding steps">
      {ONBOARDING_STEPS.map((step, index) => {
        const state = railState(index, currentIndex);
        const locked = index < lockedBeforeIndex && index !== currentIndex;
        const Icon = step.icon;
        return (
          <li key={step.id}>
            <button
              type="button"
              onClick={() => !locked && onJump(step.id)}
              disabled={locked}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${railButtonClass(state, locked)}`}
            >
              <span
                className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-xs ${railBadgeClass(state)}`}
              >
                {state === 'complete' ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Icon size={14} aria-hidden="true" />
                )}
              </span>
              <span className="truncate">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Mobile progress bar shown above the step body on small screens. */
export function MobileProgress({ current }: Readonly<{ current: OnboardingStepId }>) {
  const currentIndex = stepIndex(current);
  const progressPct = Math.round((currentIndex / (ONBOARDING_STEPS.length - 1)) * 100);
  return (
    <div className="grid gap-1.5 lg:hidden">
      <div className="flex items-center justify-between text-xs text-fg-muted">
        <span>
          Step {currentIndex + 1} of {ONBOARDING_STEPS.length}
        </span>
        <span>{ONBOARDING_STEPS[currentIndex]!.label}</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-inset"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={ONBOARDING_STEPS.length}
        aria-valuenow={currentIndex + 1}
        aria-label={`Step ${currentIndex + 1} of ${ONBOARDING_STEPS.length}: ${ONBOARDING_STEPS[currentIndex]!.label}`}
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}
