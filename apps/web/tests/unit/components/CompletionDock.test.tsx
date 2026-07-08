import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompletionDock, type CompletionDockProps } from '../../../src/components/project-message-view/CompletionDock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDock(overrides: Partial<CompletionDockProps> = {}) {
  const props: CompletionDockProps = {
    working: false,
    hasPlan: false,
    onInterrupt: vi.fn(),
    onArchive: vi.fn(),
    onOpenPlan: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<CompletionDock {...props} />) };
}

// Stub matchMedia so we can control prefers-reduced-motion per test. The global
// setup already stubs it (matches:false); tests that need reduce override it.
function setReducedMotion(reduced: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompletionDock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setReducedMotion(false);
  });

  afterEach(() => {
    setReducedMotion(false);
  });

  it('resilience: renders the Archive control when idle even though the session is active', () => {
    // Mirrors the acceptance criterion — the dock is always mounted while the
    // session is active, so the lifecycle control never disappears when the
    // agentActivity signal reads (or is stale at) idle.
    renderDock({ working: false });
    expect(screen.getByRole('button', { name: 'Archive conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Interrupt agent' })).not.toBeInTheDocument();
  });

  it('shows the Interrupt control while working (no idle Archive)', () => {
    renderDock({ working: true });
    expect(screen.getByRole('button', { name: 'Interrupt agent' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive conversation' })).not.toBeInTheDocument();
  });

  it('calls onInterrupt when the center button is clicked while working', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    const onArchive = vi.fn();
    renderDock({ working: true, onInterrupt, onArchive });

    await user.click(screen.getByRole('button', { name: 'Interrupt agent' }));

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('opens an archive confirmation when the center button is clicked while idle', async () => {
    const user = userEvent.setup();
    const onInterrupt = vi.fn();
    const onArchive = vi.fn();
    renderDock({ working: false, onInterrupt, onArchive });

    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Archive conversation?')).toBeInTheDocument();
    expect(onArchive).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('does not archive when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderDock({ working: false, onArchive });

    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('calls onArchive only after the confirmation action is clicked', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderDock({ working: false, onArchive });

    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));
    await user.click(screen.getByRole('button', { name: 'Archive Conversation' }));

    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('shows archive confirmation loading state while archiving is in flight', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onInterrupt = vi.fn();
    const onOpenPlan = vi.fn();
    const { rerender } = render(
      <CompletionDock
        working={false}
        hasPlan={false}
        onInterrupt={onInterrupt}
        onArchive={onArchive}
        onOpenPlan={onOpenPlan}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Archive conversation' }));
    rerender(
      <CompletionDock
        working={false}
        hasPlan={false}
        onInterrupt={onInterrupt}
        onArchive={onArchive}
        onOpenPlan={onOpenPlan}
        archiving
      />,
    );

    expect(screen.getByRole('button', { name: 'Archiving...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('keeps the plan pill visible while activity transitions from working to idle', async () => {
    const user = userEvent.setup();
    const onOpenPlan = vi.fn();
    const { rerender } = render(
      <CompletionDock
        working
        hasPlan
        onInterrupt={vi.fn()}
        onArchive={vi.fn()}
        onOpenPlan={onOpenPlan}
      />,
    );
    expect(screen.getByRole('button', { name: 'View plan' })).toBeInTheDocument();

    rerender(
      <CompletionDock
        working={false}
        hasPlan
        onInterrupt={vi.fn()}
        onArchive={vi.fn()}
        onOpenPlan={onOpenPlan}
      />,
    );

    const pill = screen.getByRole('button', { name: 'View plan' });
    await user.click(pill);
    expect(onOpenPlan).toHaveBeenCalledTimes(1);
  });

  it('does not show the plan pill while working when no plan exists', () => {
    renderDock({ working: true, hasPlan: false });
    expect(screen.queryByRole('button', { name: 'View plan' })).not.toBeInTheDocument();
  });

  it('disables the Archive button while archiving is in flight', () => {
    renderDock({ working: false, archiving: true });
    const btn = screen.getByRole('button', { name: 'Archive conversation' });
    expect(btn).toBeDisabled();
  });

  it('does not disable the Interrupt button while archiving is in flight', () => {
    // archiving only gates the idle Archive control, never the working Interrupt.
    renderDock({ working: true, archiving: true });
    const btn = screen.getByRole('button', { name: 'Interrupt agent' });
    expect(btn).not.toBeDisabled();
  });

  it('renders the archive error message with an alert role', () => {
    renderDock({ working: false, archiveError: 'Could not end the conversation' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not end the conversation');
  });

  it('renders the elapsed slot while working and hides it while idle', () => {
    const elapsed = <span data-testid="elapsed">01:23</span>;
    const { rerender } = render(
      <CompletionDock
        working
        hasPlan={false}
        onInterrupt={vi.fn()}
        onArchive={vi.fn()}
        onOpenPlan={vi.fn()}
        elapsed={elapsed}
      />,
    );
    expect(screen.getByTestId('elapsed')).toBeInTheDocument();

    rerender(
      <CompletionDock
        working={false}
        hasPlan={false}
        onInterrupt={vi.fn()}
        onArchive={vi.fn()}
        onOpenPlan={vi.fn()}
        elapsed={elapsed}
      />,
    );
    expect(screen.queryByTestId('elapsed')).not.toBeInTheDocument();
  });

  it('announces working/idle state via an aria-live status region', () => {
    const { rerender } = render(
      <CompletionDock working={false} hasPlan={false} onInterrupt={vi.fn()} onArchive={vi.fn()} onOpenPlan={vi.fn()} />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Agent idle');

    rerender(
      <CompletionDock working hasPlan={false} onInterrupt={vi.fn()} onArchive={vi.fn()} onOpenPlan={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Agent working');
  });

  it('reduced-motion path: still renders both morph states without animation', () => {
    setReducedMotion(true);
    const { rerender } = render(
      <CompletionDock working={false} hasPlan={false} onInterrupt={vi.fn()} onArchive={vi.fn()} onOpenPlan={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Archive conversation' })).toBeInTheDocument();

    rerender(
      <CompletionDock working hasPlan={false} onInterrupt={vi.fn()} onArchive={vi.fn()} onOpenPlan={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Interrupt agent' })).toBeInTheDocument();
  });
});
