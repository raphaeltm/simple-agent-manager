import { useQuery } from '@tanstack/react-query';

import { fetchLoginProviders } from '../lib/api/setup';

export interface LoginProviders {
  github: boolean;
  google: boolean;
  gitlab: boolean;
  email: boolean;
}

/** Shown until the deployment answers: GitHub stays visible, nothing that might error on use. */
const DEFAULT_LOGIN_PROVIDERS: LoginProviders = {
  github: true,
  google: false,
  gitlab: false,
  email: false,
};

/**
 * Which login providers are configured, for gating login buttons.
 *
 * Until the deployment answers, GitHub shows and Google, GitLab and email stay hidden, so the
 * page never offers a sign-in option that would error on use. A failed lookup is retried, and
 * again when the browser reconnects or the tab regains focus: on an email-only install the
 * defaults hide the only working way in, so one transient failure must not strand the page.
 */
export function useLoginProviders(): LoginProviders {
  const { data } = useQuery({
    queryKey: ['login-providers'],
    queryFn: fetchLoginProviders,
    retry: 3,
    staleTime: 5 * 60_000,
  });
  // The query's data and the default are both stable references, safe in effect deps.
  return data ?? DEFAULT_LOGIN_PROVIDERS;
}
