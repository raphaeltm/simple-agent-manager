import { useState, useRef, useCallback, useId, type ReactNode, type CSSProperties, type KeyboardEvent } from 'react';
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

const triggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  padding: 0,
  border: '1px solid var(--sam-color-border-default)',
  borderRadius: 'var(--sam-radius-sm)',
  background: 'transparent',
  color: 'var(--sam-color-fg-muted)',
  cursor: 'pointer',
};

const menuStyle: CSSProperties = {
  position: 'absolute',
  top: '100%',
  marginTop: 'var(--sam-space-1)',
  minWidth: 160,
  padding: 'var(--sam-space-1) 0',
  background: 'var(--sam-color-bg-surface)',
  border: '1px solid var(--sam-color-border-default)',
  borderRadius: 'var(--sam-radius-md)',
  boxShadow: 'var(--sam-shadow-dropdown)',
  zIndex: 'var(--sam-z-dropdown)',
  listStyle: 'none',
  margin: 0,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sam-space-2)',
  width: '100%',
  padding: 'var(--sam-space-2) var(--sam-space-3)',
  border: 'none',
  background: 'transparent',
  color: 'var(--sam-color-fg-primary)',
  fontSize: 'var(--sam-type-secondary-size)',
  lineHeight: 'var(--sam-type-secondary-line-height)',
  cursor: 'pointer',
  textAlign: 'left',
};

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
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={ariaLabel ?? 'Actions'}
        style={triggerStyle}
        className="sam-dropdown-trigger"
      >
        {trigger ?? <MoreVertical size={16} />}
      </button>

      {isOpen && (
        <ul
          id={menuId}
          role="menu"
          style={{
            ...menuStyle,
            ...(align === 'start' ? { left: 0 } : { right: 0 }),
          }}
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
                style={{
                  ...itemStyle,
                  ...(item.variant === 'danger' ? { color: 'var(--sam-color-danger)' } : {}),
                  ...(item.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
                }}
                className="sam-dropdown-item"
              >
                {item.icon}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <style>{`
        .sam-dropdown-trigger:hover {
          background: var(--sam-color-bg-surface-hover);
          color: var(--sam-color-fg-primary);
        }
        .sam-dropdown-item:hover:not(:disabled) {
          background: var(--sam-color-bg-surface-hover);
        }
        .sam-dropdown-item:focus-visible {
          outline: 2px solid var(--sam-color-focus-ring);
          outline-offset: -2px;
        }
      `}</style>
    </div>
  );
}
