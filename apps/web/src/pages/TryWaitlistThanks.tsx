/**
 * /try/waitlist/thanks — Confirmation screen after successful waitlist signup.
 */
import { Button } from '@simple-agent-manager/ui';
import { Link } from 'react-router';

export function TryWaitlistThanks() {
  return (
    <div
      className="min-h-[100dvh] bg-canvas flex items-center justify-center px-4 py-8"
      style={{
        paddingTop: 'max(2rem, env(safe-area-inset-top))',
        paddingBottom: 'max(2rem, env(safe-area-inset-bottom))',
      }}
    >
      <main className="w-full max-w-[640px] text-center flex flex-col gap-4" aria-labelledby="thanks-heading">
        <div
          aria-hidden
          className="mx-auto w-14 h-14 rounded-full bg-success-tint text-success-fg flex items-center justify-center text-2xl"
        >
          ✓
        </div>
        <h1 id="thanks-heading" className="sam-type-page-title text-fg-primary m-0">
          You’re on the list
        </h1>
        <p className="text-fg-muted">
          Thanks — we’ll email you the moment trials re-open. In the meantime, you can explore SAM
          with your own GitHub account.
        </p>
        <div className="flex flex-col gap-3 mt-2">
          <Button
            size="lg"
            onClick={() => {
              window.location.href = '/';
            }}
            className="w-full min-h-14"
          >
            Sign in with GitHub
          </Button>
          <Link
            to="/try"
            className="text-sm text-fg-muted hover:text-fg-primary underline underline-offset-2"
          >
            Back to trial landing
          </Link>
        </div>
      </main>
    </div>
  );
}
