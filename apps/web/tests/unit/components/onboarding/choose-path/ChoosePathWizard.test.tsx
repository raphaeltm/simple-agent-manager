import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dismissOnboarding: vi.fn(),
  useOnboarding: vi.fn(),
}));

vi.mock('../../../../../src/components/onboarding/OnboardingContext', () => ({
  useOnboarding: mocks.useOnboarding,
}));

vi.mock('../../../../../src/lib/api', () => ({
  listAgentCredentials: vi.fn(() => Promise.resolve({ credentials: [] })),
  listCredentials: vi.fn(() => Promise.resolve([])),
  listGitHubInstallations: vi.fn(() => Promise.resolve([])),
}));

import { ChoosePathWizard } from '../../../../../src/components/onboarding/choose-path/ChoosePathWizard';

describe('ChoosePathWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useOnboarding.mockReturnValue({
      showOverlay: true,
      dismissOnboarding: mocks.dismissOnboarding,
    });
  });

  it('renders the dialog when showOverlay is true', () => {
    render(<ChoosePathWizard />);
    expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Account setup' })).toBeInTheDocument();
  });

  it('renders nothing when showOverlay is false', () => {
    mocks.useOnboarding.mockReturnValue({
      showOverlay: false,
      dismissOnboarding: mocks.dismissOnboarding,
    });
    render(<ChoosePathWizard />);
    expect(screen.queryByTestId('onboarding-wizard')).not.toBeInTheDocument();
  });

  // The dialog's Escape/Tab-trap handler is attached via a document-level
  // `addEventListener('keydown', ...)` in a useEffect rather than a JSX
  // onKeyDown prop on the role="dialog" element, because
  // jsx-a11y/no-noninteractive-element-interactions correctly rejects a
  // keyboard handler on a non-interactive ARIA role. This test proves that
  // relocation preserved the actual behavior: a keydown anywhere in the
  // document (not just on the dialog element itself) still dismisses it.
  it('calls dismissOnboarding when Escape is pressed anywhere in the document', () => {
    render(<ChoosePathWizard />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mocks.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  it('does not call dismissOnboarding for a non-Escape key', () => {
    render(<ChoosePathWizard />);

    fireEvent.keyDown(document, { key: 'a' });

    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
  });

  it('does not listen for Escape once unmounted (no dangling document listener)', () => {
    const { unmount } = render(<ChoosePathWizard />);
    unmount();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
  });
});
