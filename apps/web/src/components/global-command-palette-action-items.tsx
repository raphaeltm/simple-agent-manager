import { LogOut, Moon, Plus, Server, Sun } from 'lucide-react';
import type { NavigateFunction } from 'react-router';

import type { Theme } from '../contexts/ThemeContext';
import { signOut } from '../lib/auth';
import type { ActionItem } from './global-command-palette-types';

interface BuildActionItemsParams {
  navigate: NavigateFunction;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
}

/** Builds the static command-palette action entries (create/navigate/toggle/sign-out). */
export function buildActionItems({
  navigate,
  isDark,
  setTheme,
}: BuildActionItemsParams): ActionItem[] {
  const items: ActionItem[] = [
    {
      id: 'action-new-project',
      label: 'New Project',
      action: () => navigate('/projects/new'),
      icon: <Plus size={14} />,
    },
    {
      id: 'action-create-node',
      label: 'Go to Nodes',
      action: () => navigate('/nodes'),
      icon: <Server size={14} />,
    },
    {
      id: 'action-toggle-theme',
      label: 'Toggle Theme',
      action: () => setTheme(isDark ? 'light' : 'dark'),
      icon: isDark ? <Sun size={14} /> : <Moon size={14} />,
    },
    {
      id: 'action-sign-out',
      label: 'Sign Out',
      action: () => {
        void signOut();
      },
      icon: <LogOut size={14} />,
    },
  ];
  return items;
}
