import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Landing } from '../../../src/pages/Landing';

const mockUseAuth = vi.fn();

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../../../src/lib/auth', () => ({
  signInWithGitHub: vi.fn(),
}));

vi.mock('@simple-agent-manager/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Typography: ({ children, className, as: Tag = 'span' }: { children: React.ReactNode; variant?: string; className?: string; as?: React.ElementType }) => (
    <Tag className={className}>{children}</Tag>
  ),
  Container: ({ children }: { children: React.ReactNode; maxWidth?: string }) => <div>{children}</div>,
}));

function renderLanding() {
  mockUseAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/dashboard" element={<div data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Landing page content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('shows sign-in button', () => {
    renderLanding();
    expect(screen.getByText('Sign in with GitHub')).toBeInTheDocument();
  });
});

describe('Landing page navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to /dashboard when authenticated with no state.from', () => {
    mockUseAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        </Routes>
      </MemoryRouter>,
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
      </MemoryRouter>,
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
      </MemoryRouter>,
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
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('dashboard')).not.toBeInTheDocument();
    // Landing page content should be visible
    expect(screen.getByText('Simple Agent Manager')).toBeInTheDocument();
  });
});
