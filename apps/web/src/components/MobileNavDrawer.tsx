import {
  IconButton,
  NavItem,
  NavLabel,
  PaneSeparator,
  PersonAvatar,
} from '@simple-agent-manager/ui';
import { useModalInteraction } from '@simple-agent-manager/ui/hooks/useModalInteraction';
import { ArrowLeft, ArrowRight, LogOut, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useRef, useState } from 'react';

import { GlassSheet } from './shell/GlassSheet';
import { ThemeSwitcher } from './ThemeSwitcher';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export interface MobileNavItem {
  label: string;
  path: string;
  icon?: ReactNode;
}

interface MobileNavDrawerProps {
  onClose: () => void;
  user: { name?: string | null; email: string; image?: string | null };
  navItems: MobileNavItem[];
  globalNavItems?: MobileNavItem[];
  currentPath: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  projectName?: string;
  /** Rendered below the nav items in both default and global panels */
  projectListSection?: ReactNode;
  projectHealthElement?: ReactNode;
  showGlobalNav?: boolean;
  onToggleGlobalNav?: () => void;
  /** Opens the command palette; search lives in the menu on phones. */
  onOpenSearch?: () => void;
}

function isNavItemActive(path: string, pathname: string): boolean {
  if (path === '/dashboard') {
    return pathname === '/dashboard';
  }
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function MobileNavDrawer({
  onClose,
  user,
  navItems,
  globalNavItems,
  currentPath,
  onNavigate,
  onSignOut,
  projectName,
  projectListSection,
  projectHealthElement,
  showGlobalNav,
  onToggleGlobalNav,
  onOpenSearch,
}: MobileNavDrawerProps) {
  const [isClosing, setIsClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    if (isClosing) return;
    setIsClosing(true);
    window.setTimeout(onClose, 250);
  }, [isClosing, onClose]);

  useModalInteraction({
    enabled: true,
    modalRef: panelRef,
    onEscape: handleClose,
  });

  // Determine if we're in project context with toggle capability
  const canToggle = Boolean(projectName && globalNavItems && onToggleGlobalNav);

  // Items to display in project view (without the old "Back to Projects" link)
  const projectItems = canToggle
    ? navItems.filter((item) => item.label !== 'Back to Projects')
    : navItems;

  const renderItems = (items: MobileNavItem[]) =>
    items.map((item) => (
      <NavItem
        key={item.path}
        label={item.label}
        icon={item.icon}
        current={isNavItemActive(item.path, currentPath)}
        onClick={() => onNavigate(item.path)}
        size="lg"
      />
    ));

  return (
    <GlassSheet
      label="Navigation menu"
      edge="left"
      onBackdropClick={handleClose}
      closing={isClosing}
      panelRef={panelRef}
      testId="mobile-nav-panel"
      backdropTestId="mobile-nav-backdrop"
      widthClassName="w-[85vw] max-w-80"
    >
      {/* Header: the signed-in person + close */}
      <div className="flex shrink-0 items-center gap-3 px-4 pt-4 pb-3">
        {user.image ? (
          <img
            src={user.image}
            alt={user.name || user.email}
            className="h-8 w-8 shrink-0 rounded-full shadow-[0_0_0_2px_var(--sam-separator)]"
          />
        ) : (
          <PersonAvatar name={user.name || user.email} person="you" size={32} />
        )}
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-sm font-semibold text-fg-primary">{user.name || 'User'}</p>
          <p className="m-0 truncate text-xs text-fg-muted">{user.email}</p>
        </div>
        <IconButton
          label="Close navigation"
          icon={<X size={20} strokeWidth={1.75} />}
          onClick={handleClose}
          showTooltip={false}
        />
      </div>

      {/* Search moved here from the app bar, which keeps only cross-project buttons. */}
      {onOpenSearch && (
        <div className="shrink-0 px-4 pb-2">
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Open command palette"
            className={`sam-well flex h-11 w-full cursor-pointer items-center gap-2.5 rounded-[var(--sam-radius-control)] border-0 px-3 text-left text-base text-fg-muted ${FOCUS_RING}`}
          >
            <Search size={18} strokeWidth={1.75} aria-hidden="true" />
            <span>Search...</span>
          </button>
        </div>
      )}

      {/* Toggle header: Back to Projects / Back to Project Name */}
      {canToggle && (
        <div className="shrink-0 px-2">
          <button
            onClick={onToggleGlobalNav}
            data-testid="mobile-nav-toggle"
            className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] border-none bg-transparent px-3 text-left text-[15px] text-fg-muted transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-fg-primary ${FOCUS_RING}`}
            aria-label={showGlobalNav ? `Back to ${projectName} navigation` : 'Show global navigation'}
          >
            {showGlobalNav ? (
              <>
                <ArrowRight size={18} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate">Back to {projectName}</span>
              </>
            ) : (
              <>
                <ArrowLeft size={18} strokeWidth={1.75} className="shrink-0" />
                <span>Back to Projects</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* Project name label when showing the project's own nav */}
      {projectName && !showGlobalNav && (
        <NavLabel className="shrink-0 px-5">
          <span title={projectName}>{projectName}</span>
        </NavLabel>
      )}

      {/* Nav items with slide transition */}
      {/* `data-intentional-clip`: two-panel carousel — both panels sit side by
          side (2x width) and are translated into view, so the content is
          deliberately wider than the box. See NavSidebar for the twin. */}
      <nav
        data-intentional-clip
        aria-label={showGlobalNav ? 'Primary navigation' : 'Project navigation'}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <div
          className="flex h-full transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ transform: canToggle && showGlobalNav ? 'translateX(-100%)' : 'translateX(0)' }}
        >
          {/* Panel 1: Project / default nav items */}
          <div
            className="flex w-full shrink-0 flex-col gap-0.5 overflow-y-auto px-2 pt-1 pb-2"
            aria-hidden={(canToggle && showGlobalNav) || undefined}
            inert={canToggle && showGlobalNav ? true : undefined}
          >
            {projectHealthElement && !showGlobalNav && (
              <div className="px-2 pb-2">{projectHealthElement}</div>
            )}

            {renderItems(canToggle ? projectItems : navItems)}

            {/* Project list — only in non-toggle mode (global nav) */}
            {!canToggle && projectListSection}
          </div>

          {/* Panel 2: Global nav items (only rendered when toggle is available) */}
          {canToggle && (
            <div
              className="flex w-full shrink-0 flex-col gap-0.5 overflow-y-auto px-2 pt-1 pb-2"
              aria-hidden={!showGlobalNav || undefined}
              inert={!showGlobalNav ? true : undefined}
            >
              {renderItems(globalNavItems ?? [])}

              {/* Project list — in global view within project context */}
              {projectListSection}
            </div>
          )}
        </div>
      </nav>

      <PaneSeparator className="mx-4" />

      {/* Theme switcher */}
      <div className="shrink-0 px-4 pt-3">
        <ThemeSwitcher />
      </div>

      {/* Sign out */}
      <div className="shrink-0 px-2 py-2">
        <button
          onClick={onSignOut}
          className={`flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-[11px] border-none bg-transparent px-3 text-left text-base font-medium text-danger-fg transition-colors hover:bg-[var(--sam-glass-v2-raised)] ${FOCUS_RING}`}
        >
          <LogOut size={18} strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </GlassSheet>
  );
}
