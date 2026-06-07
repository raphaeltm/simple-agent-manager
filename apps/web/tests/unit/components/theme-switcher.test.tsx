import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeSwitcher } from '../../../src/components/ThemeSwitcher';
import { ThemeProvider } from '../../../src/contexts/ThemeContext';

function installMatchMedia(prefersDark: boolean) {
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  window.matchMedia = vi.fn().mockReturnValue(mql);
}

function renderSwitcher() {
  return render(
    <ThemeProvider>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
}

function attr(): string | null {
  return document.documentElement.getAttribute('data-ui-theme');
}

describe('ThemeSwitcher', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
    installMatchMedia(true); // OS prefers dark
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-ui-theme');
    vi.restoreAllMocks();
  });

  it('renders all three options in a labelled group', () => {
    renderSwitcher();
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dark' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Light' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'System' })).toBeInTheDocument();
  });

  it('marks the active option with aria-pressed (default system)', () => {
    renderSwitcher();
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('selecting Light applies sam-light and persists', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(attr()).toBe('sam-light');
    expect(localStorage.getItem('sam-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting Dark applies sam and persists', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(attr()).toBe('sam');
    expect(localStorage.getItem('sam-theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('selecting System resolves via matchMedia and persists', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    // Start from an explicit choice, then go back to System.
    await user.click(screen.getByRole('button', { name: 'Light' }));
    expect(attr()).toBe('sam-light');

    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(localStorage.getItem('sam-theme')).toBe('system');
    // OS prefers dark in this suite → resolves to sam.
    expect(attr()).toBe('sam');
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('System resolves to light when the OS prefers light', async () => {
    installMatchMedia(false);
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    await user.click(screen.getByRole('button', { name: 'System' }));
    expect(attr()).toBe('sam-light');
  });
});
