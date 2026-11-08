import { useEffect, useState } from 'react';

import { fetchLoginProviders } from '../lib/api/setup';

export interface LoginProviders {
  github: boolean;
  google: boolean;
  gitlab: boolean;
  email: boolean;
}

/**
 * Which login providers are configured, for gating login buttons.
 *
 * Defaults show GitHub (the primary path — never hidden by a transient fetch
 * failure) and hide Google, GitLab and email until we confirm they are
 * configured, so we never render sign-in options that would error on use.
 */
export function useLoginProviders(): LoginProviders {
  const [providers, setProviders] = useState<LoginProviders>({
    github: true,
    google: false,
    gitlab: false,
    email: false,
  });

  useEffect(() => {
    let active = true;
    fetchLoginProviders()
      .then((p) => {
        if (active) {
          setProviders({ github: p.github, google: p.google, gitlab: p.gitlab, email: p.email });
        }
      })
      .catch(() => {
        /* keep defaults on failure — GitHub visible, other providers hidden */
      });
    return () => {
      active = false;
    };
  }, []);

  return providers;
}
