import type { TriggerResponse } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TriggerForm } from '../../../src/components/triggers/TriggerForm';
import { ToastProvider } from '../../../src/hooks/useToast';
import { ProjectContext, type ProjectContextValue } from '../../../src/pages/ProjectContext';

vi.mock('../../../src/lib/api', () => ({
  createTrigger: vi.fn().mockResolvedValue({}),
  updateTrigger: vi.fn().mockResolvedValue({}),
  listAgentProfiles: vi.fn().mockResolvedValue({ items: [] }),
  listSkills: vi.fn().mockResolvedValue({ items: [] }),
}));

const PROJECT_CONTEXT: ProjectContextValue = {
  projectId: 'proj-1',
  project: null,
  installations: [],
  reload: vi.fn().mockResolvedValue(undefined),
};

function renderForm(onClose = vi.fn(), editTrigger: TriggerResponse | null = null) {
  const utils = render(
    <ProjectContext.Provider value={PROJECT_CONTEXT}>
      <ToastProvider>
        <button type="button">outside control</button>
        <TriggerForm open onClose={onClose} editTrigger={editTrigger} onSaved={vi.fn()} />
      </ToastProvider>
    </ProjectContext.Provider>
  );
  return { onClose, ...utils };
}

/**
 * The create/edit drawer previously had `role="dialog" aria-modal="true"` but
 * none of the behaviour those attributes promise: no focus trap (Tab escaped
 * into the page behind), no Escape-to-close, and no scroll lock. Every "New
 * Trigger" and "Edit" click opened it, making it the busiest dialog in the
 * feature and the one least safe to use from a keyboard.
 */
describe('TriggerForm — modal interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderForm();

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });

  it('isolates the page behind it from assistive tech and tabbing', async () => {
    renderForm();

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // `hidden: true` is required to find it at all — being absent from the
    // accessibility tree is itself half the contract. The other half is that it
    // sits inside an inert/aria-hidden subtree, which is what keeps Tab inside
    // the dialog.
    const outside = screen.getByRole('button', { name: 'outside control', hidden: true });
    expect(outside.closest('[inert], [aria-hidden="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'outside control' })).toBeNull();
  });

  it('cycles Tab within the drawer instead of escaping to the page behind', async () => {
    renderForm();

    const dialog = await screen.findByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )
    );
    expect(focusable.length).toBeGreaterThan(1);

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    // Forward from the last element must wrap to the first, not leave the dialog.
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    // And backward from the first must wrap to the last.
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('locks background scrolling while open', async () => {
    const { unmount } = renderForm();

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('keeps the backdrop clickable — background isolation must not inert it', async () => {
    const user = userEvent.setup();
    const { onClose } = renderForm();

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // The backdrop lives inside the modal root precisely so `isolateBackground`
    // does not mark it inert; an inert backdrop swallows the closing click.
    const backdrop = document.querySelector('.glass-backdrop-dim');
    expect(backdrop).not.toBeNull();
    expect(backdrop?.closest('[inert]')).toBeNull();

    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalled();
  });
});
