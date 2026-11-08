import type { AgentEmailSetupPlan } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { ArrowRight, Check, ChevronDown, KeyRound, Mail, MailCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';

import { ModelToggleSwitch } from '../../components/agent-models/ModelToggleSwitch';
import { SetupHero } from './SetupShell';

export function SetupNotice({
  tone,
  children,
}: {
  tone: 'error' | 'warning';
  children: ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-5 rounded-[var(--sam-radius-control)] px-3.5 py-2.5 text-sm ${
        tone === 'error' ? 'bg-danger-tint text-danger-fg' : 'bg-warning-tint text-warning-fg'
      }`}
    >
      {children}
    </p>
  );
}

/** Each step's heading; Setup moves focus here when the step changes. */
export const SETUP_STEP_HEADING_ID = 'setup-step-heading';

function StepHeading({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <header className="mb-6 text-center">
      <h1
        id={SETUP_STEP_HEADING_ID}
        tabIndex={-1}
        className="text-[1.6rem] font-bold leading-tight outline-none sm:text-[1.9rem]"
      >
        {title}
      </h1>
      <p className="mx-auto mt-2 max-w-sm text-[0.95rem] text-fg-muted">{subtitle}</p>
    </header>
  );
}

interface WelcomeStepProps {
  domain: string;
  token: string;
  tokenFromLink: boolean;
  tokenConfigured: boolean;
  verifying: boolean;
  onTokenChange: (token: string) => void;
  onForgetLinkToken: () => void;
  onSubmit: () => void;
}

export function WelcomeStep({
  domain,
  token,
  tokenFromLink,
  tokenConfigured,
  verifying,
  onTokenChange,
  onForgetLinkToken,
  onSubmit,
}: WelcomeStepProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token.trim()) onSubmit();
  };

  return (
    <form onSubmit={submit}>
      <SetupHero />
      <StepHeading
        title="Welcome to your SAM"
        subtitle={
          <>
            <span className="font-semibold text-fg-primary">{domain}</span> is live. A couple of
            quick choices and you&apos;re in.
          </>
        }
      />
      {!tokenConfigured && (
        <SetupNotice tone="warning">
          This instance has no setup token. Redeploy it from your installer, then reload this page.
        </SetupNotice>
      )}
      {tokenFromLink ? (
        <div className="sam-well mb-5 flex items-center gap-3 rounded-[var(--sam-radius-control)] px-3.5 py-3">
          <KeyRound className="h-5 w-5 shrink-0 text-success-fg" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm">Setup token filled in from your installer</span>
          <button
            type="button"
            onClick={onForgetLinkToken}
            className="min-h-11 shrink-0 px-1 text-xs text-fg-muted underline underline-offset-2 hover:text-fg-primary"
          >
            Change
          </button>
        </div>
      ) : (
        <label className="mb-5 block space-y-1.5">
          <span className="text-sm font-medium">Setup token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            autoComplete="one-time-code"
            spellCheck={false}
            className="sam-well min-h-12 w-full rounded-[var(--sam-radius-control)] border-0 bg-transparent px-3.5 py-2.5 font-mono text-base text-fg-primary focus:outline focus:outline-2 focus:outline-[var(--sam-color-focus-ring)] sm:text-sm"
          />
          <span className="block text-xs text-fg-muted">
            It&apos;s on the &ldquo;Finish setting up SAM&rdquo; page of your installer.
          </span>
        </label>
      )}
      <Button
        type="submit"
        variant="accent"
        size="lg"
        className="w-full"
        disabled={!token.trim() || !tokenConfigured}
        loading={verifying}
      >
        Let&apos;s go
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </Button>
    </form>
  );
}

interface SignInStepProps {
  emailSignIn: boolean;
  ownerEmail: string | null;
  providerReady: boolean;
  /** Provider fields were started but not finished: finishing setup would fail validation. */
  providerPartial: boolean;
  providerFields: ReactNode;
  showProviders: boolean;
  busy: boolean;
  onShowProviders: () => void;
  onContinue: () => void;
}

export function SignInStep({
  emailSignIn,
  ownerEmail,
  providerReady,
  providerPartial,
  providerFields,
  showProviders,
  busy,
  onShowProviders,
  onContinue,
}: SignInStepProps) {
  return (
    <div>
      <StepHeading
        title="How you'll sign in"
        subtitle={
          emailSignIn
            ? 'No OAuth app needed. SAM emails you a code.'
            : 'Connect one sign-in provider. You can add more later.'
        }
      />
      {emailSignIn && (
        <div className="sam-well mb-5 flex items-start gap-3 rounded-[var(--sam-radius-control)] px-4 py-4">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-fg-on-accent">
            <Mail className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 text-sm">
            <p className="font-semibold">Email sign-in is ready</p>
            <p className="mt-0.5 break-words text-fg-muted">
              {ownerEmail ? (
                <>
                  Sign in as <span className="text-fg-primary">{ownerEmail}</span> to become the
                  administrator.
                </>
              ) : (
                'The first person to sign in becomes the administrator.'
              )}
            </p>
          </div>
        </div>
      )}
      {emailSignIn && !showProviders ? (
        <button
          type="button"
          onClick={onShowProviders}
          className="mb-5 flex min-h-11 w-full items-center justify-center gap-1.5 text-sm text-fg-muted hover:text-fg-primary"
        >
          Also allow GitHub, Google or GitLab sign-in
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <div className="mb-6">{providerFields}</div>
      )}
      <Button
        type="button"
        variant="accent"
        size="lg"
        className="w-full"
        disabled={(!emailSignIn && !providerReady) || providerPartial}
        loading={busy}
        onClick={onContinue}
      >
        Continue
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </Button>
    </div>
  );
}

interface AgentEmailStepProps {
  plan: AgentEmailSetupPlan;
  enabled: boolean;
  completing: boolean;
  onToggle: () => void;
  onFinish: () => void;
}

export function AgentEmailStep({
  plan,
  enabled,
  completing,
  onToggle,
  onFinish,
}: AgentEmailStepProps) {
  const [showChanges, setShowChanges] = useState(false);
  const changes = [
    ...plan.mainDomainChanges.map(
      (change) =>
        `${change.change === 'add' ? 'Add' : 'Remove'} ${change.type} record ${change.name}`
    ),
    ...plan.zoneChanges.map((change) => change.description),
  ];

  return (
    <div>
      <StepHeading
        title="Email your agents"
        subtitle="Start work by sending an email. Agents reply in the same thread."
      />
      <div className="sam-well mb-4 flex items-center gap-3 rounded-[var(--sam-radius-control)] px-4 py-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-fg-on-accent">
          <MailCheck className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold">Let agents receive email</p>
          <p className="mt-0.5 break-all text-fg-muted">at {plan.domain ?? 'your domain'}</p>
        </div>
        <ModelToggleSwitch checked={enabled} onChange={onToggle} label="Let agents receive email" />
      </div>
      {enabled && changes.length > 0 && (
        <div className="mb-5 text-sm">
          <button
            type="button"
            aria-expanded={showChanges}
            onClick={() => setShowChanges((open) => !open)}
            className="flex min-h-11 items-center gap-1.5 text-fg-muted hover:text-fg-primary"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showChanges ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            What changes on {plan.mainDomain ?? 'your domain'}
          </button>
          {showChanges && (
            <div className="mt-1 space-y-2 text-fg-muted">
              {plan.reason && <p>{plan.reason}</p>}
              <ul className="space-y-1">
                {changes.map((change) => (
                  <li key={change} className="flex gap-2 break-words">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-fg" aria-hidden="true" />
                    {change}
                  </li>
                ))}
              </ul>
              <p>Existing mail on your domain keeps working.</p>
            </div>
          )}
        </div>
      )}
      <Button
        type="button"
        variant="accent"
        size="lg"
        className="w-full"
        loading={completing}
        onClick={onFinish}
      >
        Finish setup
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </Button>
    </div>
  );
}

interface DoneStepProps {
  title: string;
  message: ReactNode;
  agentEmailError: string | null;
  onSignIn: () => void;
}

export function DoneStep({ title, message, agentEmailError, onSignIn }: DoneStepProps) {
  return (
    <div>
      <SetupHero celebrate />
      <StepHeading title={title} subtitle={message} />
      {agentEmailError && (
        <SetupNotice tone="warning">
          Agent email didn&apos;t turn on: {agentEmailError} You can try again from Admin →
          Integrations.
        </SetupNotice>
      )}
      <Button type="button" variant="accent" size="lg" className="w-full" onClick={onSignIn}>
        Sign in
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </Button>
    </div>
  );
}
