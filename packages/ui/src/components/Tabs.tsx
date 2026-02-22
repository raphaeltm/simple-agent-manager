import { useRef, type ReactNode, type CSSProperties, type KeyboardEvent } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

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

const tabListStyle: CSSProperties = {
  display: 'flex',
  overflowX: 'auto',
  borderBottom: '1px solid var(--sam-color-border-default)',
  scrollSnapType: 'x mandatory',
  gap: 0,
};

const tabBaseStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sam-space-2)',
  padding: 'var(--sam-space-2) var(--sam-space-4)',
  border: 'none',
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--sam-color-fg-muted)',
  fontSize: 'var(--sam-type-secondary-size)',
  fontWeight: 'var(--sam-type-secondary-weight)',
  lineHeight: 'var(--sam-type-secondary-line-height)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  scrollSnapAlign: 'start',
  transition: 'color 150ms ease, border-color 150ms ease',
};

const activeStyle: CSSProperties = {
  color: 'var(--sam-color-fg-primary)',
  borderBottomColor: 'var(--sam-color-accent-primary)',
};

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
    <div role="tablist" className={className} style={tabListStyle}>
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
            style={{
              ...tabBaseStyle,
              ...(active ? activeStyle : {}),
            }}
            className="sam-tab"
          >
            {tab.icon}
            {tab.label}
          </NavLink>
        );
      })}

      <style>{`
        .sam-tab:hover {
          color: var(--sam-color-fg-primary);
          background: var(--sam-color-bg-surface-hover);
        }
        .sam-tab:focus-visible {
          outline: 2px solid var(--sam-color-focus-ring);
          outline-offset: -2px;
        }
      `}</style>
    </div>
  );
}
