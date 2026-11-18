import { Spinner } from '@simple-agent-manager/ui';
import type { CSSProperties } from 'react';

interface LoadingPaneProps {
  /** Test hook for the surface that is loading. */
  testId?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The one loading indicator for a page or pane whose content has not arrived yet.
 *
 * It fills the free space of its flex parent and centres a large spinner in it. A
 * cold chat deep link passes through several of these in turn (project, chat route
 * chunk, transcript). Each sits in the conversation column — `ChatLoadingLayout`
 * reserves the chats sidebar before the chat page mounts — so the spinner stays where
 * it is while the reason for waiting changes underneath it. Before they shared this,
 * each boundary drew its own spinner — top-padded, centred, medium with a label — and
 * the indicator jumped around the screen.
 *
 * `py-16` keeps it clear of the top in a parent that is not a flex column.
 */
export function LoadingPane({ testId, className = '', style }: LoadingPaneProps) {
  return (
    <div
      className={`flex w-full min-w-0 flex-1 items-center justify-center py-16 ${className}`}
      data-testid={testId}
      style={style}
    >
      <Spinner size="lg" />
    </div>
  );
}
