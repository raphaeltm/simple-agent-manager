import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'user@example.com', name: 'Test User' } }),
}));

vi.mock('../../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/api')>()),
  getAgentCredentialSetupConfig: vi.fn().mockRejectedValue(new Error('gate unavailable')),
}));

import { buildAccountsModel } from '../../../../src/components/accounts/account-model';
import { useOpenProviderRows } from '../../../../src/components/accounts/AccountsOverview';
import { ConnectAccountSheet } from '../../../../src/components/accounts/ConnectAccountSheet';
import { ToastProvider } from '../../../../src/hooks/useToast';
import { QueryTestWrapper } from '../../../test-utils/query-test-utils';
import { accountRows, mergeRows, PROJECTS } from './fixtures';

function model(rows = mergeRows()) {
  return buildAccountsModel({ ...rows, projects: PROJECTS, resolution: [], limits: [] });
}

function renderSheet(props: Partial<React.ComponentProps<typeof ConnectAccountSheet>> = {}) {
  const onClose = vi.fn();
  render(
    <ToastProvider>
      <MemoryRouter>
        <ConnectAccountSheet kind="agent" groups={model().agents} onClose={onClose} {...props} />
      </MemoryRouter>
    </ToastProvider>,
    { wrapper: QueryTestWrapper }
  );
  return { onClose };
}

describe('ConnectAccountSheet', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts two steps when the provider is already chosen', () => {
    renderSheet({ providerId: 'claude-code' });

    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Connect Claude Code' })).toBeInTheDocument();
  });

  it('counts three steps from the provider picker and focuses the next step’s title', () => {
    renderSheet();

    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Claude Code/ }));
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connect Claude Code' })).toHaveFocus();
  });

  it('keeps a half-typed credential when the backdrop is tapped, but closes from the picker', () => {
    const { onClose } = renderSheet({ providerId: 'claude-code' });
    const backdrop = document.querySelector('[data-sam-modal-root] > div') as HTMLElement;

    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop tap while picking a provider', () => {
    const { onClose } = renderSheet();
    const backdrop = document.querySelector('[data-sam-modal-root] > div') as HTMLElement;

    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a dialog opened on top of it', () => {
    const { onClose } = renderSheet({ providerId: 'claude-code' });
    const nested = render(createPortal(<div data-sam-modal-root="" />, document.body));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    nested.unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('useOpenProviderRows', () => {
  it('opens a provider that becomes connected while the page is open, and keeps toggles', () => {
    const before = model(
      accountRows({ id: 'w', name: 'Work', kind: 'agent', target: 'claude-code', isDefault: true })
    ).agents;
    const { result, rerender } = renderHook(({ groups }) => useOpenProviderRows(groups), {
      initialProps: { groups: before },
    });
    expect(result.current.open).toEqual(['claude-code']);

    act(() => result.current.toggle('claude-code'));
    expect(result.current.open).toEqual([]);

    const after = model(
      mergeRows(
        accountRows({
          id: 'w',
          name: 'Work',
          kind: 'agent',
          target: 'claude-code',
          isDefault: true,
        }),
        accountRows({
          id: 'c',
          name: 'Codex',
          kind: 'agent',
          target: 'openai-codex',
          isDefault: true,
        })
      )
    ).agents;
    rerender({ groups: after });
    // The new provider opens; the one the person closed stays closed.
    expect(result.current.open).toEqual(['openai-codex']);
  });
});
