import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DropdownMenu, type DropdownMenuItem } from '../src/components/DropdownMenu';

function makeItems(overrides: Partial<DropdownMenuItem>[] = []): DropdownMenuItem[] {
  const defaults: DropdownMenuItem[] = [
    { id: 'edit', label: 'Edit', onClick: vi.fn() },
    { id: 'duplicate', label: 'Duplicate', onClick: vi.fn() },
    { id: 'delete', label: 'Delete', variant: 'danger', onClick: vi.fn() },
  ];
  return defaults.map((item, i) => ({ ...item, ...overrides[i] }));
}

describe('DropdownMenu', () => {
  it('renders trigger button with default icon', () => {
    render(<DropdownMenu items={makeItems()} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens menu on trigger click and shows items', () => {
    render(<DropdownMenu items={makeItems()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('closes menu on second trigger click', () => {
    render(<DropdownMenu items={makeItems()} />);
    const trigger = screen.getByRole('button', { name: 'Actions' });

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('calls onClick and closes on item click', () => {
    const items = makeItems();
    render(<DropdownMenu items={items} />);

    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByText('Edit'));

    expect(items[0].onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape key', () => {
    render(<DropdownMenu items={makeItems()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on click outside', () => {
    render(
      <div>
        <span data-testid="outside">Outside</span>
        <DropdownMenu items={makeItems()} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('renders danger variant with danger color', () => {
    render(<DropdownMenu items={makeItems()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    const deleteItem = screen.getByText('Delete');
    expect(deleteItem.style.color).toBe('var(--sam-color-danger)');
  });

  it('renders disabled items with aria-disabled and title', () => {
    const items = makeItems([
      {},
      { disabled: true, disabledReason: 'Not available' },
      {},
    ]);
    render(<DropdownMenu items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    const disabledItem = screen.getByText('Duplicate');
    expect(disabledItem).toHaveAttribute('aria-disabled', 'true');
    expect(disabledItem).toHaveAttribute('title', 'Not available');
  });

  it('does not call onClick for disabled items', () => {
    const items = makeItems([{}, { disabled: true }, {}]);
    render(<DropdownMenu items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(screen.getByText('Duplicate'));

    expect(items[1].onClick).not.toHaveBeenCalled();
  });

  it('navigates items with Arrow Down/Up keys', () => {
    render(<DropdownMenu items={makeItems()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    const menuItems = screen.getAllByRole('menuitem');

    // Arrow Down from first item should focus second
    fireEvent.keyDown(menuItems[0], { key: 'ArrowDown' });
    expect(menuItems[1]).toHaveFocus();

    // Arrow Up from second should focus first
    fireEvent.keyDown(menuItems[1], { key: 'ArrowUp' });
    expect(menuItems[0]).toHaveFocus();
  });

  it('wraps focus with Arrow Down from last item', () => {
    render(<DropdownMenu items={makeItems()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));

    const menuItems = screen.getAllByRole('menuitem');
    fireEvent.keyDown(menuItems[2], { key: 'ArrowDown' });
    expect(menuItems[0]).toHaveFocus();
  });

  it('supports custom aria-label', () => {
    render(<DropdownMenu items={makeItems()} aria-label="Workspace actions" />);
    expect(screen.getByRole('button', { name: 'Workspace actions' })).toBeInTheDocument();
  });
});
