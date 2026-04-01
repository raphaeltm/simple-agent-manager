import { type KeyboardEvent,type ReactNode, useRef } from 'react';
import { NavLink, useLocation } from 'react-router';

export interface Tab {
  id: string;
  label: string;
  path: string;
  icon?: ReactNode;
}

export interface TabsProps {
  tabs: Tab[];
  basePath: string;
  className?: string;
}

export function Tabs({ tabs, basePath, className }: TabsProps) {
  const location = useLocation();
  const tabRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  function getFullPath(tab: Tab): string {
    const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
    return `${base}/${tab.path}`;
  }

  function isActive(tab: Tab): boolean {
    const full = getFullPath(tab);
    return location.pathname === full || location.pathname.startsWith(full + '/');
  }

  function handleKeyDown(e: KeyboardEvent, index: number) {
    let nextIndex: number | null = null;

    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        nextIndex = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        e.preventDefault();
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        e.preventDefault();
        nextIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        nextIndex = tabs.length - 1;
        break;
    }

    if (nextIndex !== null) {
      tabRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div
      role="tablist"
      className={`flex overflow-x-auto border-b border-border-default snap-x snap-mandatory ${className ?? ''}`}
    >
      {tabs.map((tab, index) => {
        const active = isActive(tab);
        return (
          <NavLink
            key={tab.id}
            ref={(el) => { tabRefs.current[index] = el; }}
            to={getFullPath(tab)}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`sam-type-secondary inline-flex items-center gap-2 px-4 py-2 border-none border-b-2 bg-transparent no-underline whitespace-nowrap cursor-pointer snap-start transition-[color,border-color] duration-150 ease-in-out hover:text-fg-primary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:-outline-offset-2 ${active ? 'text-fg-primary border-b-accent' : 'text-fg-muted border-b-transparent'}`}
          >
            {tab.icon}
            {tab.label}
          </NavLink>
        );
      })}
    </div>
  );
}
