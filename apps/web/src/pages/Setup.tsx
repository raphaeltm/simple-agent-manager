import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import type { SetupStatusResponse, SetupVerifyResponse } from '../lib/api';
import { ApiClientError, completeSetup, fetchSetupStatus, verifySetupToken } from '../lib/api';
import {
  EMPTY_PROVIDER_VALUES,
  providerConfig,
  providerValuesComplete,
  providerValuesPartial,
  SetupProviderFields,
  type SetupProviderValues,
} from './setup/SetupProviderFields';
import { SetupShell } from './setup/SetupShell';
import {
  DoneStep,
  SETUP_STEP_HEADING_ID,
  SetupNotice,
  SignInStep,
  WelcomeStep,
} from './setup/SetupSteps';

const API_ORIGIN = import.meta.env.VITE_API_URL || 'http://localhost:8787';
/** The installer's "Open SAM setup" link carries the token here; fragments never reach a server. */
const TOKEN_FRAGMENT = /^#(?:.*&)?token=([^&]+)/;

type Step = 'welcome' | 'sign-in' | 'done';

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailVerifying, setEmailVerifying] = useState(false);

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

  // Move focus to the new step's heading, so keyboard and screen reader users land on it.
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    document.getElementById(SETUP_STEP_HEADING_ID)?.focus();
  }, [step]);

  // Setup is about getting to a running SAM. Where SAM can email sign-in codes, the token is
  // the only question: setup finishes straight away and the owner lands on the code step, with
  // the code already on its way. Other sign-in providers are optional and live in Admin.
  // Without email sign-in, one OAuth provider is the only way in, so setup asks for it.
  const handleVerify = async () => {
    setError(null);
    setBusy(true);
    try {
      const trimmed = token.trim();
      const response = await verifySetupToken(trimmed);
      // Cloudflare verifies the sending domain a few minutes after install. Closing setup on
      // email alone before then would leave no way in, so the owner waits and tries again.
      setEmailVerifying(response.signIn.email && !response.signIn.emailReady);
      if (response.signIn.email && !response.signIn.emailReady) return;
      if (response.signIn.email) {
        await completeSetup(trimmed, providerConfig(EMPTY_PROVIDER_VALUES));
        navigate('/', {
          replace: true,
          state: { signInEmail: response.signIn.ownerEmail, sendSignInCode: true },
        });
        return;
      }
      setVerified(response);
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
      await completeSetup(token.trim(), providerConfig(provider));
      setStep('done');
    } catch (err) {
      setError(errorMessage(err, 'Setup could not be completed.'));
    } finally {
      setBusy(false);
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
          onSignIn={signIn}
        />
      </SetupShell>
    );
  }

  return (
    <SetupShell footer={<span className="break-all">{instanceDomain()}</span>}>
      {error && step !== 'done' && <SetupNotice tone="error">{error}</SetupNotice>}
      {emailVerifying && step === 'welcome' && (
        <SetupNotice tone="warning">
          Cloudflare is still verifying the address SAM emails sign-in codes from. This usually
          takes a few minutes after install. Try again shortly.
        </SetupNotice>
      )}
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
          providerReady={providerValuesComplete(provider)}
          existingProvider={existingLoginProvider(verified)}
          providerPartial={providerValuesPartial(provider)}
          busy={busy}
          providerFields={
            <SetupProviderFields values={provider} onChange={setProvider} apiOrigin={API_ORIGIN} />
          }
          onContinue={() => void handleFinish()}
        />
      )}
      {step === 'done' && (
        <DoneStep
          title="You're all set"
          message="Sign in to start your first project."
          onSignIn={signIn}
        />
      )}
    </SetupShell>
  );
}

/**
 * A sign-in provider the deployment already has (for example GitHub OAuth set by a CI deploy).
 * Setup can finish with it as is; the owner should not have to re-enter its credentials.
 */
function existingLoginProvider(verified: SetupVerifyResponse | null): string | null {
  const integrations = verified?.status.integrations;
  if (!integrations) return null;
  if (integrations.githubOAuth?.configured) return 'GitHub';
  if (integrations.googleOAuth?.configured) return 'Google';
  if (integrations.gitlabOAuth?.configured) return 'GitLab';
  return null;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError && err.code === 'SETUP_CLOSED') {
    return 'Setup has already been finished.';
  }
  return err instanceof Error && err.message ? err.message : fallback;
}
