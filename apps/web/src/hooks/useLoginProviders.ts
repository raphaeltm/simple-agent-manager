import { useQuery } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { fetchLoginProviders } from '../lib/api/setup';

export interface LoginProviders {
  github: boolean;
  google: boolean;
  gitlab: boolean;
  email: boolean;
  /**
   * The deployment accepts agent sign-in through workload identity (a test instance).
   * Optional so an older deployment's answer, or one remembered by this browser, still parses.
   */
  agentSignIn?: boolean;
}

export interface LoginProvidersState {
  /**
   * The deployment's login providers: its live answer, else the last answer this browser saw.
   * `null` means neither exists yet. Render a neutral pending state then, never a guess: a guessed
   * GitHub button errors on installs without GitHub and hides email on email-only installs.
   */
  providers: LoginProviders | null;
  /** The lookup failed and there is no remembered answer to show instead. */
  failed: boolean;
  retry: () => void;
  /**
   * Whether this deployment accepts agent sign-in, for the sign-in page's disclosure. Only the
   * live answer can say `refuses`: a remembered `false` may predate trust being turned on, so it
   * never hides the disclosure. A remembered `true` is shown until the live answer arrives.
   * `checking` while the first lookup runs; `unknown` when it failed.
   */
  agentSignIn: AgentSignInDisclosure;
}

export type AgentSignInDisclosure = 'accepts' | 'refuses' | 'checking' | 'unknown';

function agentSignInDisclosure(
  live: LoginProviders | undefined,
  remembered: LoginProviders | null,
  lookupFailed: boolean
): AgentSignInDisclosure {
  if (live) return live.agentSignIn ? 'accepts' : 'refuses';
  if (remembered?.agentSignIn) return 'accepts';
  return lookupFailed ? 'unknown' : 'checking';
}

/** Last answer seen in this browser, shown on the next visit while the live lookup runs. */
export const LOGIN_PROVIDERS_STORAGE_KEY = 'sam:login-providers';

function isLoginProviders(value: unknown): value is LoginProviders {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (['github', 'google', 'gitlab', 'email'] as const).every(
      (key) => typeof record[key] === 'boolean'
    ) &&
    // Optional: answers remembered from deployments without the field still count.
    (record.agentSignIn === undefined || typeof record.agentSignIn === 'boolean')
  );
}

function readRememberedProviders(): LoginProviders | null {
  try {
    const raw = window.localStorage.getItem(LOGIN_PROVIDERS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLoginProviders(parsed) ? parsed : null;
  } catch {
    // Storage disabled or a corrupt entry: behave as a first visit.
    return null;
  }
}

async function fetchAndRememberProviders(): Promise<LoginProviders> {
  const providers = await fetchLoginProviders();
  try {
    window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  } catch {
    // Storage full or disabled: the next visit just waits for the lookup again.
  }
  return providers;
}

/**
 * Which login providers this deployment has configured, for gating sign-in options.
 *
 * Shows the last answer this browser saw while the live lookup runs, then the live answer.
 * With neither, `providers` is `null` until the deployment answers. A failed lookup is retried,
 * and again when the browser reconnects; `retry` lets a pending-state UI offer a manual retry.
 */
export function useLoginProviders(): LoginProvidersState {
  const [remembered] = useState(readRememberedProviders);
  const { data, isError, refetch } = useQuery({
    queryKey: ['login-providers'],
    queryFn: fetchAndRememberProviders,
    retry: 3,
    staleTime: 5 * 60_000,
  });
  const retry = useCallback(() => void refetch(), [refetch]);
  const providers = data ?? remembered;
  return {
    providers,
    failed: isError && !providers,
    retry,
    agentSignIn: agentSignInDisclosure(data, remembered, isError),
  };
}
