import { ChevronRight, Home } from 'lucide-react';
import type { FC } from 'react';

import { FOCUS_RING } from './types';

interface DirectoryBreadcrumbProps {
  directory: string;
  onNavigate: (directory: string) => void;
}

export const DirectoryBreadcrumb: FC<DirectoryBreadcrumbProps> = ({ directory, onNavigate }) => {
  if (directory === '/') return null;

  const segments = directory.split('/').filter(Boolean);

  return (
    <nav
      aria-label="Directory breadcrumb"
      className="flex items-center gap-1 text-sm min-w-0 overflow-x-auto"
    >
      <button
        onClick={() => onNavigate('/')}
        className={`flex items-center gap-1 px-2 py-2 min-h-[44px] rounded text-fg-muted hover:text-fg-primary hover:bg-surface-inset border-none bg-transparent cursor-pointer shrink-0 ${FOCUS_RING}`}
        aria-label="Root directory"
      >
        <Home size={14} />
      </button>
      {segments.map((seg, i) => {
        const path = '/' + segments.slice(0, i + 1).join('/') + '/';
        const isLast = i === segments.length - 1;
        return (
          <span key={path} className="flex items-center gap-1 min-w-0">
            <ChevronRight size={12} className="text-fg-muted shrink-0" aria-hidden="true" />
            {isLast ? (
              <span className="font-medium text-fg-primary truncate px-2 py-2" aria-current="page">
                {seg}
              </span>
            ) : (
              <button
                onClick={() => onNavigate(path)}
                className={`px-2 py-2 min-h-[44px] rounded text-fg-muted hover:text-fg-primary hover:bg-surface-inset border-none bg-transparent cursor-pointer truncate ${FOCUS_RING}`}
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
};
