import { readFileSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { Landing } from '../../../src/pages/Landing';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  Typography: ({ children, className }: { children: React.ReactNode; variant?: string; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  Container: ({ children }: { children: React.ReactNode; maxWidth?: string }) => <div>{children}</div>,
}));

describe('Landing page source contract', () => {
  const file = readFileSync(resolve(__dirname, '../../../src/pages/Landing.tsx'), 'utf8');

  it('does not advertise idle-based zero-cost behavior', () => {
    expect(file).not.toContain('Zero Cost');
    expect(file).not.toContain('When idle');
  });

  it('includes BYOC messaging', () => {
    expect(file).toContain('Bring your own cloud');
    expect(file).toContain('your infrastructure, your costs');
  });

  it('does not contain marketing sections', () => {
    expect(file).not.toContain('How It Works');
    expect(file).not.toContain('Choose Your Agent');
    expect(file).not.toContain('Platform Features');
    expect(file).not.toContain('Shipped & Planned');
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
