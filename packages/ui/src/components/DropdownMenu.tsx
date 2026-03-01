import { useState, useRef, useCallback, useId, type ReactNode, type KeyboardEvent } from 'react';
import { MoreVertical } from 'lucide-react';
import { useClickOutside } from '../hooks/useClickOutside';
import { useEscapeKey } from '../hooks/useEscapeKey';

export interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}

export interface DropdownMenuProps {
  items: DropdownMenuItem[];
  trigger?: ReactNode;
  align?: 'start' | 'end';
  'aria-label'?: string;
}

export function DropdownMenu({ items, trigger, align = 'end', 'aria-label': ariaLabel }: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback(() => {
    setIsOpen(false);
    setFocusIndex(-1);
    triggerRef.current?.focus();
  }, []);

  useClickOutside(containerRef, close, isOpen);
  useEscapeKey(close, isOpen);

  function handleTriggerClick() {
    if (isOpen) {
      close();
    } else {
      setIsOpen(true);
      setFocusIndex(0);
      requestAnimationFrame(() => {
        itemRefs.current[0]?.focus();
      });
    }
  }

  function handleTriggerKeyDown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIsOpen(true);
      setFocusIndex(0);
      requestAnimationFrame(() => {
        itemRefs.current[0]?.focus();
      });
    }
  }

  function handleItemKeyDown(e: KeyboardEvent, index: number) {
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = (index + 1) % items.length;
        setFocusIndex(next);
        itemRefs.current[next]?.focus();
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = (index - 1 + items.length) % items.length;
        setFocusIndex(prev);
        itemRefs.current[prev]?.focus();
        break;
      }
      case 'Tab':
        close();
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = items[index];
        if (item && !item.disabled) {
          item.onClick();
          close();
        }
        break;
      }
    }
  }

  function handleItemClick(item: DropdownMenuItem) {
    if (!item.disabled) {
      item.onClick();
      close();
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={ariaLabel ?? 'Actions'}
        className="inline-flex items-center justify-center w-8 h-8 p-0 border border-border-default rounded-sm bg-transparent text-fg-muted cursor-pointer hover:bg-surface-hover hover:text-fg-primary"
      >
        {trigger ?? <MoreVertical size={16} />}
      </button>

      {isOpen && (
        <ul
          id={menuId}
          role="menu"
          className={`absolute top-full mt-1 min-w-40 py-1 m-0 list-none bg-surface border border-border-default rounded-md shadow-dropdown z-dropdown ${align === 'start' ? 'left-0' : 'right-0'}`}
        >
          {items.map((item, index) => (
            <li key={item.id} role="none">
              <button
                ref={(el) => { itemRefs.current[index] = el; }}
                role="menuitem"
                tabIndex={focusIndex === index ? 0 : -1}
                disabled={item.disabled}
                aria-disabled={item.disabled || undefined}
                title={item.disabled ? item.disabledReason : undefined}
                onClick={() => handleItemClick(item)}
                onKeyDown={(e) => handleItemKeyDown(e, index)}
                className={`sam-type-secondary flex items-center gap-2 w-full px-3 py-2 border-none bg-transparent text-left cursor-pointer hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2 ${item.variant === 'danger' ? 'text-danger' : 'text-fg-primary'} ${item.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
