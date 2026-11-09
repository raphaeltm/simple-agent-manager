import { Button } from '@simple-agent-manager/ui';
import { ArrowRight, KeyRound } from 'lucide-react';
import { type FormEvent, type ReactNode } from 'react';

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
            <span className="font-semibold text-fg-primary">{domain}</span> is live. One step and
            you&apos;re in.
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
  providerReady: boolean;
  /** Provider fields were started but not finished: finishing setup would fail validation. */
  providerPartial: boolean;
  providerFields: ReactNode;
  busy: boolean;
  onContinue: () => void;
}

/** Only for instances that cannot email sign-in codes: one OAuth provider is the way in. */
export function SignInStep({
  providerReady,
  providerPartial,
  providerFields,
  busy,
  onContinue,
}: SignInStepProps) {
  return (
    <div>
      <StepHeading
        title="How you'll sign in"
        subtitle="Connect one sign-in provider. You can add more later."
      />
      <div className="mb-6">{providerFields}</div>
      <Button
        type="button"
        variant="accent"
        size="lg"
        className="w-full"
        disabled={!providerReady || providerPartial}
        loading={busy}
        onClick={onContinue}
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
  onSignIn: () => void;
}

export function DoneStep({ title, message, onSignIn }: DoneStepProps) {
  return (
    <div>
      <SetupHero celebrate />
      <StepHeading title={title} subtitle={message} />
      <Button type="button" variant="accent" size="lg" className="w-full" onClick={onSignIn}>
        Sign in
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </Button>
    </div>
  );
}
