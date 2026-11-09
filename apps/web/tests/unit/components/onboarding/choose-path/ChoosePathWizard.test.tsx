import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dismissOnboarding: vi.fn(),
  useOnboarding: vi.fn(),
  getArtifactsEnabled: vi.fn(),
}));

// `useQueryScope()` reads the authenticated identity; `useSetupStatus` keys its
// three queries by it. Without a provider `useAuth` throws.
vi.mock('../../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../../src/components/onboarding/OnboardingContext', () => ({
  useOnboarding: mocks.useOnboarding,
}));

vi.mock('../../../../../src/lib/api', () => ({
  listAgentCredentials: vi.fn(() => Promise.resolve({ credentials: [] })),
  listCredentials: vi.fn(() => Promise.resolve([])),
  listGitHubInstallations: vi.fn(() => Promise.resolve([])),
  listProjects: vi.fn(() => Promise.resolve({ projects: [] })),
  getArtifactsEnabled: mocks.getArtifactsEnabled,
}));

import { ChoosePathWizard } from '../../../../../src/components/onboarding/choose-path/ChoosePathWizard';
import { QueryTestWrapper } from '../../../../test-utils/query-test-utils';

describe('ChoosePathWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useOnboarding.mockReturnValue({
      showOverlay: true,
      dismissOnboarding: mocks.dismissOnboarding,
    });
    mocks.getArtifactsEnabled.mockResolvedValue(false);
  });

  it.each([
    [true, ['Let SAM host it', 'GitHub — I have a repo']],
    [false, ['GitHub — I have a repo']],
  ])('with Artifacts enabled=%s, the repository question offers %j', async (enabled, shown) => {
    mocks.getArtifactsEnabled.mockResolvedValue(enabled);
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
    await waitFor(() => expect(mocks.getArtifactsEnabled).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: /Use SAM-managed infrastructure/ }));
    expect(
      await screen.findByRole('heading', { name: 'Where should your code live?' })
    ).toBeInTheDocument();
    for (const label of shown) {
      expect(await screen.findByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
    if (!enabled) expect(screen.queryByRole('button', { name: /Let SAM host it/ })).toBeNull();
  });

  it('renders the dialog when showOverlay is true', () => {
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
    expect(screen.getByTestId('onboarding-wizard')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Account setup' })).toBeInTheDocument();
  });

  it('renders nothing when showOverlay is false', () => {
    mocks.useOnboarding.mockReturnValue({
      showOverlay: false,
      dismissOnboarding: mocks.dismissOnboarding,
    });
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
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
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mocks.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  // The guided agent sign-in opens its own modal from inside the wizard. Escape there must
  // close only that modal, not throw away the whole setup.
  it('leaves Escape to a dialog opened from inside the wizard', () => {
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
    const nested = document.createElement('div');
    nested.setAttribute('role', 'dialog');
    nested.setAttribute('aria-modal', 'true');
    document.body.appendChild(nested);
    try {
      fireEvent.keyDown(nested, { key: 'Escape' });
      expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
    } finally {
      nested.remove();
    }
    // Control: with the nested dialog gone, Escape dismisses again.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(mocks.dismissOnboarding).toHaveBeenCalledTimes(1);
  });

  it('holds the repository question until it knows whether SAM can host repositories', async () => {
    let resolve!: (enabled: boolean) => void;
    mocks.getArtifactsEnabled.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });

    fireEvent.click(screen.getByRole('button', { name: /Use SAM-managed infrastructure/ }));
    expect(await screen.findByRole('status', { name: 'Loading options' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GitHub — I have a repo/ })).toBeNull();

    resolve(true);
    const options = await screen.findAllByRole('button', { name: /Let SAM host it|GitHub/ });
    expect(options[0]).toHaveAccessibleName(/Let SAM host it/);
  });

  it('does not call dismissOnboarding for a non-Escape key', () => {
    render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });

    fireEvent.keyDown(document, { key: 'a' });

    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
  });

  it('does not listen for Escape once unmounted (no dangling document listener)', () => {
    const { unmount } = render(<ChoosePathWizard />, { wrapper: QueryTestWrapper });
    unmount();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(mocks.dismissOnboarding).not.toHaveBeenCalled();
  });
});
