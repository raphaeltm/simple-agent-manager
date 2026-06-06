import { MoreVertical } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

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

export function DropdownMenu({
  items,
  trigger,
  align = 'end',
  'aria-label': ariaLabel,
}: DropdownMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback(() => {
    setIsOpen(false);
    setFocusIndex(-1);
    triggerRef.current?.focus();
  }, []);

  useEscapeKey(close, isOpen);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const menuWidth = Math.max(menuRef.current?.offsetWidth ?? 160, 160);
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const gutter = 8;
    const idealLeft = align === 'start' ? rect.left : rect.right - menuWidth;
    const maxLeft = window.innerWidth - menuWidth - gutter;
    const left = Math.max(gutter, Math.min(idealLeft, maxLeft));
    const belowTop = rect.bottom + 4;
    const aboveTop = rect.top - menuHeight - 4;
    const top =
      menuHeight > 0 && belowTop + menuHeight > window.innerHeight - gutter && aboveTop >= gutter
        ? aboveTop
        : Math.max(gutter, Math.min(belowTop, window.innerHeight - menuHeight - gutter));

    setMenuStyle({
      position: 'fixed',
      top,
      left,
      minWidth: 160,
      zIndex: 'var(--sam-z-dropdown)' as unknown as number,
    });
  }, [align]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updateMenuPosition();
  }, [isOpen, updateMenuPosition]);

  useEffect(() => {
    if (!isOpen) return;

    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      close();
    }

    document.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [close, isOpen, updateMenuPosition]);

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

      {isOpen &&
        createPortal(
          <ul
            ref={menuRef}
            id={menuId}
            role="menu"
            className="py-1 m-0 list-none glass-surface rounded-md shadow-dropdown"
            style={{
              minWidth: 160,
              width: 'max-content',
              maxWidth: 'calc(100vw - 16px)',
              ...menuStyle,
            }}
          >
            {items.map((item, index) => (
              <li key={item.id} role="none">
                <button
                  ref={(el) => {
                    itemRefs.current[index] = el;
                  }}
                  role="menuitem"
                  tabIndex={focusIndex === index ? 0 : -1}
                  disabled={item.disabled}
                  aria-disabled={item.disabled || undefined}
                  title={item.disabled ? item.disabledReason : undefined}
                  onClick={() => handleItemClick(item)}
                  onKeyDown={(e) => handleItemKeyDown(e, index)}
                  className={`sam-type-secondary flex items-center gap-2 w-full max-w-full px-3 py-2 border-none bg-transparent text-left cursor-pointer hover:bg-[var(--sam-chrome-accent-soft)] focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2 ${item.variant === 'danger' ? 'text-danger' : 'text-fg-primary'} ${item.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  {item.icon}
                  <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                    {item.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>,
          document.body
        )}
    </div>
  );
}
