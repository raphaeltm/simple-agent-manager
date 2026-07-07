import { useEffect, useState } from 'react';

import { fetchLoginProviders } from '../lib/api/setup';

export interface LoginProviders {
  github: boolean;
  google: boolean;
}

/**
 * Which login providers are configured, for gating login buttons.
 *
 * Defaults show GitHub (the primary path — never hidden by a transient fetch
 * failure) and hide Google until we confirm a login client is configured, so we
 * never render a "Sign in with Google" button that would error on click.
 */
export function useLoginProviders(): LoginProviders {
  const [providers, setProviders] = useState<LoginProviders>({ github: true, google: false });

  useEffect(() => {
    let active = true;
    fetchLoginProviders()
      .then((p) => {
        if (active) setProviders({ github: p.github, google: p.google });
      })
      .catch(() => {
        /* keep defaults on failure — GitHub visible, Google hidden */
      });
    return () => {
      active = false;
    };
  }, []);

  return providers;
}
