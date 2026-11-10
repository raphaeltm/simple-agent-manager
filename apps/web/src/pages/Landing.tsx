import { Button, GlassNodeField, Typography } from '@simple-agent-manager/ui';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAuth } from '../components/AuthProvider';
import { EmailCodeSignIn } from '../components/EmailCodeSignIn';
import { LoginProvidersPending } from '../components/LoginProvidersPending';
import { useLoginProviders } from '../hooks/useLoginProviders';
import { signInWithGitHub, signInWithGitLab, signInWithGoogle } from '../lib/auth';
import { PUBLIC_WEBSITE_URL } from '../lib/public-website';

const AGENTS = ['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Mistral Vibe'];

/**
 * App sign-in page — a centered glass card over SAM's node network, drawn by the shared
 * glass node field (the same renderer as the marketing site hero).
 */
export function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const { providers, failed: providersFailed, retry: retryProviders } = useLoginProviders();
  const navigate = useNavigate();
  const location = useLocation();
  // Capture state.from once on mount to avoid double-navigation when
  // navigate(replace: true) clears the state and re-triggers the effect.
  const fromRef = useRef((location.state as { from?: Location })?.from);
  // First-run setup hands over the installer owner's address so they only type the code.
  const handoff = location.state as {
    signInEmail?: string | null;
    sendSignInCode?: boolean;
  } | null;
  const signInEmail = handoff?.signInEmail ?? '';
  // Finishing first-run setup asks for the owner's code straight away, so they only enter it.
  const sendCodeOnArrival = Boolean(signInEmail && handoff?.sendSignInCode);
  const hasOAuth = Boolean(providers && (providers.github || providers.google || providers.gitlab));

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      navigate(returnPath(fromRef.current), { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  // A code sign-in sets the session cookie outside BetterAuth's session store; load the app
  // fresh so every provider reads the new session (an auth change, rule 16).
  const handleEmailSignedIn = () => window.location.assign(returnPath(fromRef.current));

  const handleGitHubSignIn = async () => {
    try {
      await signInWithGitHub();
    } catch (error) {
      console.error('Failed to sign in:', error);
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      await signInWithGoogle();
    } catch (error) {
      console.error('Failed to sign in with Google:', error);
    }
  };

  const handleGitLabSignIn = async () => {
    try {
      await signInWithGitLab();
    } catch (error) {
      console.error('Failed to sign in with GitLab:', error);
    }
  };

  return (
    // The app locks page scrolling on desktop (index.css), so this page scrolls itself: the
    // email code form can make the card taller than a short window.
    <main className="relative isolate h-[var(--sam-app-height)] overflow-y-auto overflow-x-hidden bg-canvas">
      <div className="pointer-events-none fixed inset-0 -z-10">
        <GlassNodeField mode="floor" density={0.16} horizonY={0.5} />
      </div>
      <div className="flex min-h-full items-center justify-center px-3 py-8 sm:px-4">
        <div className="sam-glass sam-glass-rim w-full max-w-sm text-center rounded-2xl px-6 py-8">
          <Typography variant="display" as="h1" className="mb-2">
            Simple Agent Manager
          </Typography>

          {sendCodeOnArrival ? (
            // Continuing straight out of setup: no need to re-sell SAM, just hand off cleanly.
            <p className="text-fg-muted text-sm mb-6">One step left.</p>
          ) : (
            <>
              <p className="text-fg-muted text-sm mb-6">
                Launch AI coding agents on your own cloud infrastructure.
              </p>

              <div className="flex flex-wrap justify-center gap-2 mb-8">
                {AGENTS.map((name) => (
                  <span
                    key={name}
                    className="px-2.5 py-0.5 rounded-full bg-inset border border-[rgba(34,197,94,0.10)] text-xs font-medium"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </>
          )}

          {!providers && (
            <div className="mb-3">
              <LoginProvidersPending failed={providersFailed} retry={retryProviders} />
            </div>
          )}

          {providers?.github && (
            <Button onClick={handleGitHubSignIn} size="lg" className="w-full mb-3">
              <GitHubIcon />
              Sign in with GitHub
            </Button>
          )}
          {providers?.google && (
            <Button
              onClick={handleGoogleSignIn}
              variant="secondary"
              size="lg"
              className="w-full mb-3"
            >
              <GoogleMark />
              Sign in with Google
            </Button>
          )}
          {providers?.gitlab && (
            <Button
              onClick={handleGitLabSignIn}
              variant="secondary"
              size="lg"
              className="w-full mb-3"
            >
              <GitLabMark />
              Sign in with GitLab
            </Button>
          )}

          {providers?.email && (
            <>
              {hasOAuth && (
                <div
                  className="my-4 flex items-center gap-3 text-xs text-fg-muted"
                  aria-hidden="true"
                >
                  <span className="h-px flex-1 bg-border-default" />
                  or
                  <span className="h-px flex-1 bg-border-default" />
                </div>
              )}
              <div className="mb-3">
                <EmailCodeSignIn
                  initialEmail={signInEmail}
                  sendOnMount={sendCodeOnArrival}
                  primary={!hasOAuth}
                  onSignedIn={handleEmailSignedIn}
                />
              </div>
            </>
          )}

          {!sendCodeOnArrival && (
            <>
              <p className="text-xs text-fg-muted mb-6">
                Bring your own cloud &mdash; your infrastructure, your costs.
              </p>

              <a
                href={PUBLIC_WEBSITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-fg-muted hover:text-fg-primary underline underline-offset-2"
              >
                Learn more about SAM
              </a>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** The page the user was sent here from, when it is a safe internal path; else the dashboard. */
function returnPath(from: Location | undefined): string {
  // ProtectedRoute passes the original page as location.state.from. Reject protocol-relative
  // paths like //evil.com.
  const isSafePath = from?.pathname?.startsWith('/') && !from.pathname.startsWith('//');
  return from && isSafePath
    ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`
    : '/dashboard';
}

function GitHubIcon() {
  return (
    <svg
      className="h-5 w-5 mr-2"
      fill="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-sm font-semibold text-[#1a73e8]"
    >
      G
    </span>
  );
}

function GitLabMark() {
  return (
    <span
      aria-hidden="true"
      className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-sm bg-[#fc6d26] text-[10px] font-bold text-white"
    >
      GL
    </span>
  );
}
