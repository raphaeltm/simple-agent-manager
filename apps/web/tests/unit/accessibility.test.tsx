import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as baseRender, type RenderOptions, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../../src/components/AppShell';
import { SkipToContent } from '../../src/components/SkipToContent';
import { ThemeProvider } from '../../src/contexts/ThemeContext';

function TestProviders({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>{children}</ThemeProvider>
    </QueryClientProvider>
  );
}

function render(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return baseRender(ui, { wrapper: TestProviders, ...options });
}

let matchMediaMatches = false;
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      get matches() { return matchMediaMatches; },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

vi.mock('../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: { name: 'Test User', email: 'test@example.com', image: null },
    isSuperadmin: false,
  }),
}));

vi.mock('../../src/lib/auth', () => ({
  signOut: vi.fn(),
}));

vi.mock('../../src/hooks/useProjectData', () => ({
  useProjectList: () => ({ projects: [], loading: false }),
}));

vi.mock('../../src/components/GlobalAudioPlayer', () => ({
  GlobalAudioPlayer: () => null,
}));

describe('SkipToContent component', () => {
  it('renders a skip link pointing to #main-content', () => {
    render(
      <MemoryRouter>
        <SkipToContent />
      </MemoryRouter>,
    );
    const link = screen.getByText('Skip to content');
    expect(link).toBeDefined();
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('#main-content');
  });

  it('has sr-only class by default (visually hidden until focused)', () => {
    render(
      <MemoryRouter>
        <SkipToContent />
      </MemoryRouter>,
    );
    const link = screen.getByText('Skip to content');
    expect(link.className).toContain('sr-only');
  });
});

describe('AppShell accessibility', () => {
  it('renders a skip-to-content link on desktop', () => {
    matchMediaMatches = true;
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    const links = screen.getAllByText('Skip to content');
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].getAttribute('href')).toBe('#main-content');
  });

  it('renders a skip-to-content link on mobile', () => {
    matchMediaMatches = false;
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    const links = screen.getAllByText('Skip to content');
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].getAttribute('href')).toBe('#main-content');
  });

  it('renders main element with id="main-content" on desktop', () => {
    matchMediaMatches = true;
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    const main = document.getElementById('main-content');
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe('MAIN');
  });

  it('renders main element with id="main-content" on mobile', () => {
    matchMediaMatches = false;
    render(
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>,
    );
    const main = document.getElementById('main-content');
    expect(main).not.toBeNull();
    expect(main?.tagName).toBe('MAIN');
  });
});
