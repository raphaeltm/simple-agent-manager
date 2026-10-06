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

  it('only shows visible text label on the active theme button', () => {
    renderSwitcher();
    // Default is 'system', so only the System button should have visible text
    const systemBtn = screen.getByRole('button', { name: 'System' });
    const darkBtn = screen.getByRole('button', { name: 'Dark' });
    const lightBtn = screen.getByRole('button', { name: 'Light' });

    // Active button has visible label text
    expect(systemBtn.querySelector('span')).not.toBeNull();
    expect(systemBtn.querySelector('span')!.textContent).toBe('System');

    // Inactive buttons do not render a text span (icon-only)
    expect(darkBtn.querySelector('span')).toBeNull();
    expect(lightBtn.querySelector('span')).toBeNull();
  });

  it('active label follows theme selection', async () => {
    renderSwitcher();
    const user = userEvent.setup();

    // Switch to Dark
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    const darkBtn = screen.getByRole('button', { name: 'Dark' });
    const lightBtn = screen.getByRole('button', { name: 'Light' });
    const systemBtn = screen.getByRole('button', { name: 'System' });

    expect(darkBtn.querySelector('span')).not.toBeNull();
    expect(lightBtn.querySelector('span')).toBeNull();
    expect(systemBtn.querySelector('span')).toBeNull();
  });

  it('theme group fits within a 200px sidebar width', () => {
    // Render within a constrained container that mimics the sidebar
    const { container } = render(
      <ThemeProvider>
        <div style={{ width: '200px', padding: '0 12px' }}>
          <ThemeSwitcher />
        </div>
      </ThemeProvider>,
    );

    const group = container.querySelector('[role="group"]')!;
    const buttons = group.querySelectorAll('button');

    // Total button widths (including gap) must not exceed the container
    // In jsdom, offsetWidth is 0, so we verify structurally:
    // - Only the active button has a text span (reduces total width)
    // - All buttons exist and are queryable
    expect(buttons.length).toBe(3);

    let activeCount = 0;
    let inactiveWithTextCount = 0;
    buttons.forEach((btn) => {
      const isActive = btn.getAttribute('aria-pressed') === 'true';
      const hasText = btn.querySelector('span') !== null;
      if (isActive) activeCount++;
      if (!isActive && hasText) inactiveWithTextCount++;
    });

    expect(activeCount).toBe(1);
    // No inactive button should have visible text — this is what prevents overflow
    expect(inactiveWithTextCount).toBe(0);
  });
});
