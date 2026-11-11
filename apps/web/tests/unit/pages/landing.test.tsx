import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_PROVIDERS_STORAGE_KEY } from '../../../src/hooks/useLoginProviders';
import { Landing } from '../../../src/pages/Landing';

const fetchLoginProviders = vi.hoisted(() => vi.fn());
vi.mock('../../../src/lib/api/setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/setup')>()),
  fetchLoginProviders,
}));

const GITHUB_ONLY = { github: true, google: false, gitlab: false, email: false };
const EMAIL_ONLY = { github: false, google: false, gitlab: false, email: true };

const mockUseAuth = vi.fn();

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../../../src/lib/auth', () => ({
  signInWithGitHub: vi.fn(),
  signInWithGitLab: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

vi.mock('@simple-agent-manager/ui', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Typography: ({
    children,
    className,
    as: Tag = 'span',
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
    as?: React.ElementType;
  }) => <Tag className={className}>{children}</Tag>,
  Container: ({ children }: { children: React.ReactNode; maxWidth?: string }) => (
    <div>{children}</div>
  ),
  Spinner: () => <span data-testid="spinner" />,
  GlassNodeField: () => <div data-testid="glass-node-field" aria-hidden="true" />,
}));

/** The login-provider lookup is a TanStack query, so every render needs a fresh client. */
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The hook sets its own retry count; skip the backoff so failure tests run fast.
  client.setQueryDefaults(['login-providers'], { retryDelay: 0 });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function renderLanding() {
  mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<div data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Landing page content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fetchLoginProviders.mockResolvedValue(GITHUB_ONLY);
  });

  it('draws the shared glass node field behind the sign-in card', () => {
    renderLanding();
    expect(screen.getByTestId('glass-node-field')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Simple Agent Manager' })).toBeInTheDocument();
  });

  it('shows BYOC messaging', () => {
    renderLanding();
    expect(screen.getByText(/Bring your own cloud/)).toBeInTheDocument();
    expect(screen.getByText(/your infrastructure, your costs/)).toBeInTheDocument();
  });

  it('does not show removed marketing sections', () => {
    renderLanding();
    expect(screen.queryByText('How It Works')).not.toBeInTheDocument();
    expect(screen.queryByText('Choose Your Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Platform Features')).not.toBeInTheDocument();
    expect(screen.queryByText('Shipped & Planned')).not.toBeInTheDocument();
  });

  it('does not advertise idle-based zero-cost behavior', () => {
    renderLanding();
    expect(screen.queryByText(/Zero Cost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/When idle/)).not.toBeInTheDocument();
  });

  it('shows supported agent names', () => {
    renderLanding();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
    expect(screen.getByText('Gemini CLI')).toBeInTheDocument();
  });

  it('shows sign-in button', async () => {
    renderLanding();
    expect(await screen.findByText('Sign in with GitHub')).toBeInTheDocument();
  });
});

describe('Landing agent sign-in notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('tells people when the instance accepts agent sign-in', async () => {
    fetchLoginProviders.mockResolvedValue({ ...GITHUB_ONLY, agentSignIn: true });
    renderLanding();
    expect(await screen.findByRole('note')).toHaveTextContent(
      /test instance\. Agents from a trusted SAM installation can sign in here/
    );
  });

  it('says nothing about agent sign-in on an ordinary instance', async () => {
    fetchLoginProviders.mockResolvedValue({ ...GITHUB_ONLY, agentSignIn: false });
    renderLanding();
    // Liveness: the deployment's answer rendered, so the absence below is meaningful.
    expect(await screen.findByRole('button', { name: /Sign in with GitHub/ })).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});

describe('Landing sign-in options before the deployment answers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('shows a neutral pending state, not a guessed GitHub button, on a first visit', async () => {
    let answer: (value: typeof EMAIL_ONLY) => void = () => {};
    fetchLoginProviders.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderLanding();

    // Liveness: the card rendered, the options are pending, and nothing was guessed.
    expect(screen.getByRole('heading', { name: 'Simple Agent Manager' })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Loading sign-in options' })).toBeInTheDocument();
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();

    answer(EMAIL_ONLY);
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Loading sign-in options' })
    ).not.toBeInTheDocument();
  });

  it('shows the options this browser saw last time while the lookup runs', async () => {
    window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(EMAIL_ONLY));
    fetchLoginProviders.mockReturnValue(new Promise(() => {}));
    renderLanding();

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Loading sign-in options' })
    ).not.toBeInTheDocument();
  });

  it('replaces a remembered answer with the live one', async () => {
    window.localStorage.setItem(LOGIN_PROVIDERS_STORAGE_KEY, JSON.stringify(EMAIL_ONLY));
    fetchLoginProviders.mockResolvedValue(GITHUB_ONLY);
    renderLanding();

    expect(await screen.findByText('Sign in with GitHub')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument());
  });

  it('offers a retry when the lookup fails and nothing is remembered', async () => {
    fetchLoginProviders.mockRejectedValue(new Error('network down'));
    renderLanding();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText(/Couldn.t load the sign-in options/)).toBeInTheDocument();
    expect(screen.queryByText('Sign in with GitHub')).not.toBeInTheDocument();

    fetchLoginProviders.mockResolvedValue(EMAIL_ONLY);
    retry.click();
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
  });
});

describe('Landing page navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fetchLoginProviders.mockResolvedValue(GITHUB_ONLY);
  });

  it('navigates to /dashboard when authenticated with no state.from', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('navigates to state.from when authenticated after redirect', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    const fromLocation = { pathname: '/projects/abc', search: '?tab=chat', hash: '' };
    render(
      <MemoryRouter initialEntries={[{ pathname: '/', state: { from: fromLocation } }]}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
          <Route path="/projects/:id" element={<div data-testid="project-page" />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('project-page')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
  });

  it('rejects protocol-relative paths in state.from (open redirect defense)', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    const maliciousFrom = { pathname: '//evil.com/steal', search: '', hash: '' };
    render(
      <MemoryRouter initialEntries={[{ pathname: '/', state: { from: maliciousFrom } }]}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>
    );
    // Should fall back to /dashboard, not navigate to //evil.com
    expect(screen.getByTestId('dashboard')).toBeInTheDocument();
  });

  it('shows landing content when not authenticated', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    // Landing page content should be visible
    expect(screen.getByText('Simple Agent Manager')).toBeInTheDocument();
  });
});
