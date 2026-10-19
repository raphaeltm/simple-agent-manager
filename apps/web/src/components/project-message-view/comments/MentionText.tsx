import type { CommentMention } from '@simple-agent-manager/shared';
import { Fragment, useMemo } from 'react';

import { splitMentionSegments } from './comment-mentions';

/**
 * A comment body with its structured @mentions highlighted.
 *
 * Only `@Name` runs that match the comment's `mentions` are styled; any other `@text` is
 * ordinary text, exactly as the server treats it. Rendered as React text nodes, never HTML.
 * Segments are a pure function of the text, so their position is a stable key.
 */
export function MentionText({
  text,
  mentions,
}: Readonly<{ text: string; mentions?: readonly CommentMention[] }>) {
  const segments = useMemo(() => splitMentionSegments(text, mentions), [text, mentions]);
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'mention' ? (
          <span key={index} data-comment-mention="" className="font-medium text-accent">
            {segment.text}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}
