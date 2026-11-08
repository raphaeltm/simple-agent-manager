import { buttonClassName, GlassNodeField, Typography } from '@simple-agent-manager/ui';

import { SELF_HOST_URL } from '../lib/public-website';

/**
 * Landing spot for links into the retired anonymous-trial flow (`/try`, `/try/<id>`, and the
 * old cap-exceeded and waitlist pages). SAM is self-hosted now, so the page points visitors at
 * the self-hosting guide. Both ways out are explicit links: nothing navigates on its own.
 */
export function RetiredTrial() {
  return (
    <main className="relative isolate min-h-[var(--sam-app-height)] bg-canvas flex items-center justify-center px-3 py-8 sm:px-4 overflow-hidden">
      <GlassNodeField mode="floor" density={0.16} horizonY={0.5} />
      <div className="sam-glass sam-glass-rim w-full max-w-sm text-center rounded-2xl px-6 py-8">
        <Typography variant="display" as="h1" className="mb-2">
          Hosted trials have ended
        </Typography>
        <p className="text-fg-muted text-sm mb-6">
          SAM runs on your own Cloudflare account and cloud provider. Deploy your own instance with
          the self-hosting guide.
        </p>
        <a
          href={SELF_HOST_URL}
          className={`${buttonClassName({ size: 'lg' })} w-full no-underline`}
        >
          Self-host SAM
        </a>
        <a
          href="/"
          className="mt-3 inline-flex min-h-11 items-center justify-center px-2 text-xs text-fg-muted hover:text-fg-primary underline underline-offset-2"
        >
          Already have access? Sign in
        </a>
      </div>
    </main>
  );
}
