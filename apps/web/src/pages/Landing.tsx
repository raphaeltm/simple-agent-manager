import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { signInWithGitHub } from '../lib/auth';
import { useAuth } from '../components/AuthProvider';
import { Button, Typography } from '@simple-agent-manager/ui';

const PUBLIC_WEBSITE_URL =
  import.meta.env.VITE_PUBLIC_WEBSITE_URL || 'https://simple-agent-manager.org';

const AGENTS = ['Claude Code', 'OpenAI Codex', 'Gemini CLI', 'Mistral Vibe'];

/**
 * App sign-in page — clean, centered layout with GitHub OAuth.
 */
export function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Capture state.from once on mount to avoid double-navigation when
  // navigate(replace: true) clears the state and re-triggers the effect.
  const fromRef = useRef((location.state as { from?: Location })?.from);

  useEffect(() => {
    if (isAuthenticated && !isLoading) {
      // Respect the original page the user was on before being redirected to login.
      // ProtectedRoute passes this as location.state.from when redirecting.
      const from = fromRef.current;
      // Validate pathname is a safe internal path (not protocol-relative like //evil.com)
      const isSafePath = from?.pathname?.startsWith('/') && !from.pathname.startsWith('//');
      const returnTo = from && isSafePath
        ? `${from.pathname}${from.search ?? ''}${from.hash ?? ''}`
        : '/dashboard';
      navigate(returnTo, { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  const handleSignIn = async () => {
    try {
      await signInWithGitHub();
    } catch (error) {
      console.error('Failed to sign in:', error);
    }
  };

  return (
    <div className="min-h-[var(--sam-app-height)] bg-canvas flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <Typography variant="display" as="h1" className="mb-2">
          Simple Agent Manager
        </Typography>

        <p className="text-fg-muted text-sm mb-6">
          Launch AI coding agents on your own cloud infrastructure.
        </p>

        <div className="flex flex-wrap justify-center gap-2 mb-8">
          {AGENTS.map((name) => (
            <span
              key={name}
              className="px-2.5 py-0.5 rounded-full bg-surface border border-border-default text-xs font-medium"
            >
              {name}
            </span>
          ))}
        </div>

        <Button onClick={handleSignIn} size="lg" className="w-full mb-3">
          <GitHubIcon />
          Sign in with GitHub
        </Button>

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
      </div>
    </div>
  );
}

function GitHubIcon() {
  return (
    <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.167 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
    </svg>
  );
}
