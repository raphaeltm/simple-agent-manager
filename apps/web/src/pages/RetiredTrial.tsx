import { buttonClassName, GlassNodeField, Typography } from '@simple-agent-manager/ui';
import { useEffect } from 'react';

import { SELF_HOST_URL } from '../lib/public-website';

/**
 * Landing spot for links into the retired anonymous-trial flow (`/try`, `/try/<id>`, and the
 * old cap-exceeded and waitlist pages). SAM is self-hosted now, so the page sends visitors to
 * the self-hosting guide straight away and keeps a plain link in case the redirect is blocked.
 */
export function RetiredTrial() {
  useEffect(() => {
    window.location.replace(SELF_HOST_URL);
  }, []);

  return (
    <main className="relative isolate min-h-[var(--sam-app-height)] bg-canvas flex items-center justify-center px-3 py-8 sm:px-4 overflow-hidden">
      <GlassNodeField mode="floor" density={0.16} horizonY={0.5} />
      <div className="sam-glass sam-glass-rim w-full max-w-sm text-center rounded-2xl px-6 py-8">
        <Typography variant="display" as="h1" className="mb-2">
          Hosted trials have ended
        </Typography>
        <p className="text-fg-muted text-sm mb-6">
          SAM runs on your own Cloudflare account and cloud provider. Taking you to the
          self-hosting guide…
        </p>
        <a
          href={SELF_HOST_URL}
          className={`${buttonClassName({ size: 'lg' })} w-full no-underline`}
        >
          Self-host SAM
        </a>
        <a
          href="/"
          className="mt-4 inline-block text-xs text-fg-muted hover:text-fg-primary underline underline-offset-2"
        >
          Already have access? Sign in
        </a>
      </div>
    </main>
  );
}
