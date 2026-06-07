import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeSwitcher } from '../../../src/components/ThemeSwitcher';
import { THEME_STORAGE_KEY, ThemeProvider } from '../../../src/contexts/ThemeContext';

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

  // Select an option and assert it became the active, persisted, resolved theme.
  async function selectAndExpect(
    label: 'Dark' | 'Light' | 'System',
    stored: string,
    resolvedAttr: string,
  ) {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: label }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(stored);
    expect(attr()).toBe(resolvedAttr);
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  }

  it.each([
    { label: 'Light', stored: 'light', resolvedAttr: 'sam-light' },
    { label: 'Dark', stored: 'dark', resolvedAttr: 'sam' },
  ] as const)('selecting $label persists $stored and applies $resolvedAttr', async ({ label, stored, resolvedAttr }) => {
    renderSwitcher();
    await selectAndExpect(label, stored, resolvedAttr);
  });

  it('selecting System resolves via matchMedia and persists', async () => {
    renderSwitcher();
    // Start from an explicit choice, then go back to System.
    await selectAndExpect('Light', 'light', 'sam-light');
    // OS prefers dark in this suite → System resolves to sam.
    await selectAndExpect('System', 'system', 'sam');
  });

  it('System resolves to light when the OS prefers light', async () => {
    installMatchMedia(false);
    renderSwitcher();
    await selectAndExpect('Dark', 'dark', 'sam');
    await selectAndExpect('System', 'system', 'sam-light');
  });
});
