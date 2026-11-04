import { PaneSeparator, PersonAvatar } from '@simple-agent-manager/ui';
import { LogOut, Search } from 'lucide-react';
import type { ReactNode } from 'react';

import type { FocusMode } from '../../lib/focus-mode';
import { isMacPlatform } from '../../lib/keyboard-shortcuts';
import { FocusModeToggle } from '../FocusModeToggle';
import { NavSidebar } from '../NavSidebar';
import { NotificationCenter } from '../NotificationCenter';
import { RecentChatsDropdown } from '../RecentChatsDropdown';
import { ThemeSwitcher } from '../ThemeSwitcher';

interface SidebarUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/**
 * The desktop navigation pane: logo with Recent chats and Notifications, the search well,
 * the nav items, the layout control, theme and the signed-in person.
 *
 * In Focus Mode it narrows to an icon rail: labels move into tooltips and the cross-project
 * buttons and theme control step aside, as they did before SAM Glass.
 */
export function DesktopSidebar({
  focusMode,
  onSelectFocusMode,
  onCycleFocusMode,
  onOpenCommandPalette,
  projectName,
  showGlobalNav,
  onToggleGlobalNav,
  projectListSection,
  projectHealthElement,
  user,
  onSignOut,
}: {
  focusMode: FocusMode;
  onSelectFocusMode: (mode: FocusMode) => void;
  onCycleFocusMode: () => void;
  onOpenCommandPalette: () => void;
  projectName?: string;
  showGlobalNav: boolean;
  onToggleGlobalNav: () => void;
  projectListSection: ReactNode;
  projectHealthElement: ReactNode;
  user: SidebarUser | null;
  onSignOut: () => void;
}) {
  const iconOnly = focusMode === 'focus';
  const userName = user?.name || user?.email || 'You';

  return (
    <>
      <div
        className={`flex shrink-0 items-center px-3 pt-3 pb-2 ${iconOnly ? 'justify-center' : 'justify-between'}`}
      >
        <img src="/sam-head.png" alt="SAM" className="h-8 w-8 object-contain" />
        {!iconOnly && (
          <div className="flex items-center">
            <RecentChatsDropdown />
            <NotificationCenter />
          </div>
        )}
      </div>

      <div className="shrink-0 px-3 pb-1">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          title={iconOnly ? 'Search...' : undefined}
          className={`sam-well flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-[var(--sam-radius-control)] border-0 text-sm text-fg-muted transition-colors hover:text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
            iconOnly ? 'justify-center px-0' : 'px-3'
          }`}
        >
          <Search size={16} strokeWidth={1.75} aria-hidden="true" />
          {!iconOnly && (
            <>
              <span className="flex-1 text-left">Search...</span>
              <kbd className="rounded-md border border-[var(--sam-chip-edge)] bg-[var(--sam-chip-bg)] px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                {isMacPlatform() ? '⌘K' : 'Ctrl+K'}
              </kbd>
            </>
          )}
        </button>
      </div>

      <NavSidebar
        projectName={projectName}
        showGlobalNav={showGlobalNav}
        onToggleGlobalNav={onToggleGlobalNav}
        projectListSection={projectListSection}
        projectHealthElement={projectHealthElement}
        iconOnly={iconOnly}
      />

      <div className={`shrink-0 ${iconOnly ? 'px-2' : 'px-3'} pt-2 pb-2`}>
        <FocusModeToggle
          mode={focusMode}
          onSelect={onSelectFocusMode}
          onCycle={onCycleFocusMode}
          variant={iconOnly ? 'cycle' : 'segmented'}
        />
      </div>

      {user && (
        <div className="shrink-0">
          <PaneSeparator className={iconOnly ? 'mx-2' : 'mx-3'} />
          {!iconOnly && (
            <div className="px-3 pt-2.5">
              <ThemeSwitcher />
            </div>
          )}
          <div
            className={`flex items-center gap-2.5 ${iconOnly ? 'flex-col px-2 py-2.5' : 'px-3 pt-2 pb-3'}`}
          >
            {user.image ? (
              <img
                src={user.image}
                alt={userName}
                className="h-[26px] w-[26px] shrink-0 rounded-full shadow-[0_0_0_2px_var(--sam-separator)]"
              />
            ) : (
              <PersonAvatar name={userName} person="you" size={26} />
            )}
            {!iconOnly && (
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-primary">
                {userName}
              </span>
            )}
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="inline-grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[10px] border-0 bg-transparent text-fg-muted transition-colors hover:bg-[var(--sam-glass-v2-raised)] hover:text-danger-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <LogOut size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
