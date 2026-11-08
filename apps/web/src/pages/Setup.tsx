import type { AgentEmailSetupPlan } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import type { SetupStatusResponse, SetupVerifyResponse } from '../lib/api';
import { ApiClientError, completeSetup, fetchSetupStatus, verifySetupToken } from '../lib/api';
import {
  EMPTY_PROVIDER_VALUES,
  providerConfig,
  providerValuesComplete,
  SetupProviderFields,
  type SetupProviderValues,
} from './setup/SetupProviderFields';
import { SetupShell, type SetupStepMarker } from './setup/SetupShell';
import { AgentEmailStep, DoneStep, SetupNotice, SignInStep, WelcomeStep } from './setup/SetupSteps';

const API_ORIGIN = import.meta.env.VITE_API_URL || 'http://localhost:8787';
/** The installer's "Open SAM setup" link carries the token here; fragments never reach a server. */
const TOKEN_FRAGMENT = /^#(?:.*&)?token=([^&]+)/;

type Step = 'welcome' | 'sign-in' | 'agent-email' | 'done';

/** Agent email can be turned on during setup only from these plan states. */
const RUNNABLE_AGENT_EMAIL_STATES = new Set(['ready', 'needs_consent', 'changed']);

// Read once per page load: the fragment is removed on first read, and the page can mount more
// than once while the app's providers settle.
let linkTokenCache: string | null = null;

function readTokenFromLink(): string {
  if (linkTokenCache !== null) return linkTokenCache;
  const match = TOKEN_FRAGMENT.exec(window.location.hash);
  linkTokenCache = '';
  if (!match?.[1]) return linkTokenCache;
  // Keep the token out of history and anything that later reads the URL.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    linkTokenCache = decodeURIComponent(match[1]);
  } catch {
    // A malformed fragment leaves the token field empty for the owner to paste.
  }
  return linkTokenCache;
}

function instanceDomain(): string {
  return window.location.hostname.replace(/^app\./, '');
}

export function Setup() {
  const navigate = useNavigate();
  const [linkToken] = useState(readTokenFromLink);
  const [token, setToken] = useState(linkToken);
  const [tokenFromLink, setTokenFromLink] = useState(Boolean(linkToken));
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [verified, setVerified] = useState<SetupVerifyResponse | null>(null);
  const [step, setStep] = useState<Step>('welcome');
  const [provider, setProvider] = useState<SetupProviderValues>(EMPTY_PROVIDER_VALUES);
  const [showProviders, setShowProviders] = useState(false);
  const [agentEmailOn, setAgentEmailOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentEmailError, setAgentEmailError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchSetupStatus()
      .then((response) => {
        if (active) setStatus(response);
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiClientError && err.code === 'SETUP_CLOSED') {
          setStatus({ completed: true, open: false, forced: false, tokenConfigured: false });
          return;
        }
        setError(err instanceof Error ? err.message : 'Could not reach your SAM API.');
        setStatus({ completed: false, open: true, forced: false, tokenConfigured: true });
      });
    return () => {
      active = false;
    };
  }, []);

  const agentEmailPlan: AgentEmailSetupPlan | null =
    verified?.agentEmail && RUNNABLE_AGENT_EMAIL_STATES.has(verified.agentEmail.state)
      ? verified.agentEmail
      : null;
  const emailSignIn = verified?.signIn.email ?? false;

  const steps: SetupStepMarker[] = [
    { key: 'welcome', label: 'Welcome' },
    { key: 'sign-in', label: 'Sign-in' },
    ...(agentEmailPlan || !verified ? [{ key: 'agent-email', label: 'Email' }] : []),
  ];

  const handleVerify = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await verifySetupToken(token.trim());
      setVerified(response);
      setShowProviders(!response.signIn.email);
      setStep('sign-in');
    } catch (err) {
      setError(errorMessage(err, 'That setup token did not work.'));
      setTokenFromLink(false);
    } finally {
      setBusy(false);
    }
  };

  const handleFinish = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await completeSetup(
        token.trim(),
        providerConfig(provider),
        agentEmailPlan && agentEmailOn ? { consentToken: agentEmailPlan.consentToken } : undefined
      );
      setAgentEmailError(response.agentEmail?.error ?? null);
      setStep('done');
    } catch (err) {
      setError(errorMessage(err, 'Setup could not be completed.'));
    } finally {
      setBusy(false);
    }
  };

  const handleContinueFromSignIn = () => {
    if (agentEmailPlan) {
      setError(null);
      setStep('agent-email');
    } else {
      void handleFinish();
    }
  };

  const signIn = () =>
    navigate('/', { replace: true, state: { signInEmail: verified?.signIn.ownerEmail ?? null } });

  if (!status) {
    return (
      <SetupShell>
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      </SetupShell>
    );
  }

  if (status.completed && step !== 'done') {
    return (
      <SetupShell>
        <DoneStep
          title="SAM is set up"
          message="Setup is already finished for this instance."
          agentEmailError={null}
          onSignIn={signIn}
        />
      </SetupShell>
    );
  }

  return (
    <SetupShell
      steps={step === 'done' ? undefined : steps}
      currentStep={step}
      footer={<span className="break-all">{instanceDomain()}</span>}
    >
      {error && step !== 'done' && <SetupNotice tone="error">{error}</SetupNotice>}
      {step === 'welcome' && (
        <WelcomeStep
          domain={instanceDomain()}
          token={token}
          tokenFromLink={tokenFromLink}
          tokenConfigured={status.tokenConfigured}
          verifying={busy}
          onTokenChange={setToken}
          onForgetLinkToken={() => {
            setTokenFromLink(false);
            setToken('');
          }}
          onSubmit={() => void handleVerify()}
        />
      )}
      {step === 'sign-in' && (
        <SignInStep
          emailSignIn={emailSignIn}
          ownerEmail={verified?.signIn.ownerEmail ?? null}
          providerReady={providerValuesComplete(provider)}
          showProviders={showProviders}
          onShowProviders={() => setShowProviders(true)}
          busy={busy && !agentEmailPlan}
          providerFields={
            <SetupProviderFields values={provider} onChange={setProvider} apiOrigin={API_ORIGIN} />
          }
          onContinue={handleContinueFromSignIn}
        />
      )}
      {step === 'agent-email' && agentEmailPlan && (
        <AgentEmailStep
          plan={agentEmailPlan}
          enabled={agentEmailOn}
          completing={busy}
          onToggle={() => setAgentEmailOn((on) => !on)}
          onFinish={() => void handleFinish()}
        />
      )}
      {step === 'done' && (
        <DoneStep
          title="You're all set"
          message={
            emailSignIn
              ? "Sign in with your email and we'll send you a code."
              : 'Sign in to start your first project.'
          }
          agentEmailError={agentEmailError}
          onSignIn={signIn}
        />
      )}
    </SetupShell>
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.code === 'SETUP_CLOSED') {
    return 'Setup has already been finished.';
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
