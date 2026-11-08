import { IconButton, Pane } from '@simple-agent-manager/ui';
import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { NotificationCenter } from '../NotificationCenter';
import { RecentChatsDropdown } from '../RecentChatsDropdown';
import { IMMERSIVE_CHROME } from './chat-immersive-transition';

/** The screen's main toggle, raised at the right edge of the mobile app bar. */
export interface ShellScreenAction {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Whether the surface it opens is open, for `aria-expanded`. */
  expanded?: boolean;
  /** Items waiting on the user behind this toggle, shown as an amber count. Put it in `label` too. */
  count?: number;
}

/**
 * The single floating app bar on phones: menu on the left (its drawer slides from the left),
 * the project name, Recent chats and Notifications grouped in a well because both work
 * across projects, and the screen's main toggle raised at the right edge.
 */
export function MobileAppBar({
  projectName,
  onOpenMenu,
  screenAction,
}: {
  projectName?: string;
  onOpenMenu: () => void;
  screenAction: ShellScreenAction | null;
}) {
  return (
    <Pane
      as="header"
      variant="slab"
      data-immersive-chrome={IMMERSIVE_CHROME.appBar}
      className="relative z-30 flex h-14 shrink-0 items-center gap-1 pr-1.5 pl-1"
    >
      <IconButton
        label="Open navigation menu"
        icon={<Menu size={22} strokeWidth={1.75} />}
        onClick={onOpenMenu}
        showTooltip={false}
      />
      <Link
        to="/dashboard"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      >
        <img src="/sam-head.png" alt="SAM" className="h-7 w-7 shrink-0 object-contain" />
        {projectName && (
          <span className="min-w-0 truncate text-[17px] font-semibold text-fg-primary">
            {projectName}
          </span>
        )}
      </Link>
      <div className="sam-well flex shrink-0 items-center rounded-[14px] p-0.5">
        <RecentChatsDropdown />
        <NotificationCenter />
      </div>
      {screenAction && (
        <IconButton
          raised
          label={screenAction.label}
          icon={screenAction.icon}
          onClick={screenAction.onClick}
          aria-expanded={screenAction.expanded}
          count={screenAction.count}
          countTone="attention"
          showTooltip={false}
          className="ml-1"
        />
      )}
    </Pane>
  );
}
