import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, LogOut } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

export interface MobileNavItem {
  label: string;
  path: string;
  icon?: ReactNode;
}

interface InfraSection {
  items: MobileNavItem[];
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
  infraSection?: InfraSection;
  showGlobalNav?: boolean;
  onToggleGlobalNav?: () => void;
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
  infraSection,
  showGlobalNav,
  onToggleGlobalNav,
}: MobileNavDrawerProps) {
  const [infraOpen, setInfraOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Determine if we're in project context with toggle capability
  const canToggle = Boolean(projectName && globalNavItems && onToggleGlobalNav);

  // Items to display in project view (without the old "Back to Projects" link)
  const projectItems = canToggle
    ? navItems.filter((item) => item.label !== 'Back to Projects')
    : navItems;

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="mobile-nav-backdrop"
        onClick={onClose}
        className="fixed inset-0 bg-overlay z-drawer-backdrop"
        style={{ animation: 'sam-drawer-fade-in 0.15s ease-out' }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        data-testid="mobile-nav-panel"
        className="fixed top-0 right-0 bottom-0 w-[85vw] max-w-80 bg-surface border-l border-border-default z-drawer flex flex-col overflow-hidden"
        style={{ animation: 'sam-drawer-slide-in 0.2s ease-out' }}
      >
        {/* Header: user info + close */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default">
          {user.image ? (
            <img
              src={user.image}
              alt={user.name || user.email}
              className="h-9 w-9 rounded-full shrink-0"
            />
          ) : (
            <div className="h-9 w-9 rounded-full bg-accent flex items-center justify-center text-fg-on-accent text-sm font-medium shrink-0">
              {(user.name || user.email).charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-fg-primary m-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {user.name || 'User'}
            </p>
            <p className="text-xs text-fg-muted m-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {user.email}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className={`flex items-center justify-center w-10 h-10 bg-transparent border-none text-fg-muted cursor-pointer shrink-0 rounded-sm ${FOCUS_RING}`}
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Toggle header: Back to Projects / Back to Project Name */}
        {canToggle && (
          <button
            onClick={onToggleGlobalNav}
            data-testid="mobile-nav-toggle"
            className={`flex items-center gap-3 w-full px-5 py-3 bg-transparent border-none border-b border-border-default cursor-pointer text-left text-sm font-medium text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-all duration-150 ${FOCUS_RING}`}
            aria-label={showGlobalNav ? `Back to ${projectName} navigation` : 'Show global navigation'}
          >
            {showGlobalNav ? (
              <>
                <ArrowRight size={16} className="shrink-0" />
                <span className="truncate">Back to {projectName}</span>
              </>
            ) : (
              <>
                <ArrowLeft size={16} className="shrink-0" />
                <span>Back to Projects</span>
              </>
            )}
          </button>
        )}

        {/* Project name header when in project context and showing project nav */}
        {projectName && !showGlobalNav && !canToggle && (
          <div className="px-5 py-2 text-xs font-semibold text-fg-muted uppercase tracking-wider truncate border-b border-border-default" title={projectName}>
            {projectName}
          </div>
        )}

        {/* Project name under toggle button when showing project nav */}
        {canToggle && !showGlobalNav && (
          <div className="px-5 py-2 text-xs font-semibold text-fg-muted uppercase tracking-wider truncate border-b border-border-default" title={projectName}>
            {projectName}
          </div>
        )}

        {/* Nav items with slide transition */}
        <nav
          aria-label={showGlobalNav ? 'Primary navigation' : 'Project navigation'}
          className="flex-1 overflow-hidden relative"
        >
          <div
            className="flex transition-transform duration-200 ease-out motion-reduce:transition-none h-full"
            style={{ transform: canToggle && showGlobalNav ? 'translateX(-50%)' : 'translateX(0)' }}
          >
            {/* Panel 1: Project / default nav items */}
            <div
              className="w-full shrink-0 pt-2 overflow-y-auto"
              aria-hidden={(canToggle && showGlobalNav) || undefined}
              inert={canToggle && showGlobalNav ? true : undefined}
            >
              {(canToggle ? projectItems : navItems).map((item) => {
                const active = isNavItemActive(item.path, currentPath);
                return (
                  <button
                    key={item.path}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-3 w-full min-h-11 px-5 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${FOCUS_RING} ${
                      active
                        ? 'text-accent border-l-accent bg-accent-tint'
                        : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                    }`}
                    onClick={() => onNavigate(item.path)}
                  >
                    {item.icon && <span className="shrink-0">{item.icon}</span>}
                    {item.label}
                  </button>
                );
              })}

              {/* Infrastructure section — only in non-toggle mode */}
              {!canToggle && infraSection && (
                <div className="mt-2">
                  <button
                    onClick={() => setInfraOpen(!infraOpen)}
                    className={`flex items-center gap-2 w-full px-5 py-2.5 bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-[120ms] ${FOCUS_RING}`}
                    aria-expanded={infraOpen}
                    aria-controls="mobile-infra-nav-panel"
                  >
                    {infraOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Infrastructure
                  </button>
                  {infraOpen && (
                    <div id="mobile-infra-nav-panel">
                      {infraSection.items.map((item) => {
                        const active = isNavItemActive(item.path, currentPath);
                        return (
                          <button
                            key={item.path}
                            aria-current={active ? 'page' : undefined}
                            className={`flex items-center gap-3 w-full min-h-11 px-5 pl-8 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${FOCUS_RING} ${
                              active
                                ? 'text-accent border-l-accent bg-accent-tint'
                                : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                            }`}
                            onClick={() => onNavigate(item.path)}
                          >
                            {item.icon && <span className="shrink-0">{item.icon}</span>}
                            {item.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Panel 2: Global nav items (only rendered when toggle is available) */}
            {canToggle && (
              <div
                className="w-full shrink-0 pt-2 overflow-y-auto"
                aria-hidden={!showGlobalNav || undefined}
                inert={!showGlobalNav ? true : undefined}
              >
                {(globalNavItems ?? []).map((item) => {
                  const active = isNavItemActive(item.path, currentPath);
                  return (
                    <button
                      key={item.path}
                      aria-current={active ? 'page' : undefined}
                      className={`flex items-center gap-3 w-full min-h-11 px-5 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${FOCUS_RING} ${
                        active
                          ? 'text-accent border-l-accent bg-accent-tint'
                          : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                      }`}
                      onClick={() => onNavigate(item.path)}
                    >
                      {item.icon && <span className="shrink-0">{item.icon}</span>}
                      {item.label}
                    </button>
                  );
                })}

                {/* Infrastructure section — in global view */}
                {infraSection && (
                  <div className="mt-2">
                    <button
                      onClick={() => setInfraOpen(!infraOpen)}
                      className={`flex items-center gap-2 w-full px-5 py-2.5 bg-transparent border-none text-xs font-semibold text-fg-muted uppercase tracking-wider cursor-pointer hover:text-fg-primary hover:bg-surface-hover transition-all duration-[120ms] ${FOCUS_RING}`}
                      aria-expanded={infraOpen}
                      aria-controls="mobile-infra-nav-panel-global"
                    >
                      {infraOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      Infrastructure
                    </button>
                    {infraOpen && (
                      <div id="mobile-infra-nav-panel-global">
                        {infraSection.items.map((item) => {
                          const active = isNavItemActive(item.path, currentPath);
                          return (
                            <button
                              key={item.path}
                              aria-current={active ? 'page' : undefined}
                              className={`flex items-center gap-3 w-full min-h-11 px-5 pl-8 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 transition-all duration-[120ms] ${FOCUS_RING} ${
                                active
                                  ? 'text-accent border-l-accent bg-accent-tint'
                                  : 'text-fg-muted border-l-transparent hover:text-fg-primary hover:bg-surface-hover'
                              }`}
                              onClick={() => onNavigate(item.path)}
                            >
                              {item.icon && <span className="shrink-0">{item.icon}</span>}
                              {item.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </nav>

        {/* Sign out */}
        <div className="border-t border-border-default py-2">
          <button
            onClick={onSignOut}
            className={`flex items-center gap-3 w-full min-h-11 px-5 py-2.5 text-base font-medium bg-transparent border-none cursor-pointer text-left border-l-3 border-l-transparent text-danger-fg hover:bg-surface-hover transition-all duration-[120ms] ${FOCUS_RING}`}
          >
            <LogOut size={18} />
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}
