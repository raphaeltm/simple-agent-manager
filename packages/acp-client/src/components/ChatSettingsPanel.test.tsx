import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatSettingsPanel } from './ChatSettingsPanel';
import type { ChatSettingsPanelProps } from './ChatSettingsPanel';

const defaultModes = [
  { value: 'default', label: 'Default' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'bypassPermissions', label: 'Bypass Permissions' },
];

function renderPanel(overrides: Partial<ChatSettingsPanelProps> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props: ChatSettingsPanelProps = {
    settings: { model: null, permissionMode: 'default' },
    loading: false,
    permissionModes: defaultModes,
    onSave,
    onClose,
    ...overrides,
  };
  const result = render(<ChatSettingsPanel {...props} />);
  return { ...result, onSave, onClose };
}

describe('ChatSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders as a fixed bottom sheet dialog', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: /agent settings/i });
    expect(dialog).not.toBeNull();
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.style.bottom).toBe('0px');
  });

  it('renders a backdrop overlay', () => {
    renderPanel();
    // Backdrop is the element before the dialog
    const dialog = screen.getByRole('dialog', { name: /agent settings/i });
    const backdrop = dialog.previousElementSibling;
    expect(backdrop).not.toBeNull();
    expect(backdrop?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders permission mode buttons', () => {
    renderPanel();
    expect(screen.getByText('Default')).not.toBeNull();
    expect(screen.getByText('Accept Edits')).not.toBeNull();
    expect(screen.getByText('Bypass Permissions')).not.toBeNull();
  });

  it('renders model input', () => {
    renderPanel();
    expect(screen.getByPlaceholderText('Default (agent decides)')).not.toBeNull();
  });

  it('renders loading state', () => {
    renderPanel({ loading: true });
    expect(screen.getByText('Loading settings...')).not.toBeNull();
  });

  it('visually distinguishes the selected permission mode', () => {
    renderPanel({ settings: { model: null, permissionMode: 'acceptEdits' } });
    const acceptBtn = screen.getByText('Accept Edits');
    // Selected mode uses accent color border
    expect(acceptBtn.style.borderColor).toContain('accent-primary');
  });

  it('shows warning when bypassPermissions is selected', () => {
    renderPanel({ settings: { model: null, permissionMode: 'bypassPermissions' } });
    expect(screen.getByText(/auto-approve all actions/i)).not.toBeNull();
  });

  it('disables Save button when no changes are made', () => {
    renderPanel();
    const saveBtn = screen.getByText('Save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('enables Save button when permission mode changes', () => {
    renderPanel({ settings: { model: null, permissionMode: 'default' } });
    fireEvent.click(screen.getByText('Accept Edits'));
    const saveBtn = screen.getByText('Save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('enables Save button when model changes', () => {
    renderPanel({ settings: { model: null, permissionMode: 'default' } });
    fireEvent.change(screen.getByPlaceholderText('Default (agent decides)'), {
      target: { value: 'claude-opus-4-6' },
    });
    const saveBtn = screen.getByText('Save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
  });

  it('calls onSave with updated data and closes on success', async () => {
    const { onSave, onClose } = renderPanel({
      settings: { model: null, permissionMode: 'default' },
    });

    fireEvent.click(screen.getByText('Accept Edits'));
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        model: null,
        permissionMode: 'acceptEdits',
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when close button is clicked', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByLabelText('Close settings'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when backdrop is clicked', () => {
    const { onClose } = renderPanel();
    const dialog = screen.getByRole('dialog', { name: /agent settings/i });
    const backdrop = dialog.previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', () => {
    const { onClose } = renderPanel();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('populates model field from existing settings', () => {
    renderPanel({ settings: { model: 'gpt-5-codex', permissionMode: 'default' } });
    const input = screen.getByPlaceholderText('Default (agent decides)') as HTMLInputElement;
    expect(input.value).toBe('gpt-5-codex');
  });

  it('constrains max width for desktop readability', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: /agent settings/i });
    expect(dialog.style.maxWidth).toBe('480px');
  });

  it('constrains max height to 80vh for scroll safety', () => {
    renderPanel();
    const dialog = screen.getByRole('dialog', { name: /agent settings/i });
    expect(dialog.style.maxHeight).toBe('80vh');
  });
});
