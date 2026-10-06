/**
 * Collapsed activity card for a run of consecutive tool calls.
 *
 * Level 1 (this card) answers "is something happening?" in one compact line.
 * Level 2 is the EXISTING `ToolCallCard`, rendered unchanged in the expanded
 * body, so lazy content loading, diff/terminal rendering and the file-click
 * wiring keep working exactly as before.
 *
 * Collapsing unmounts the per-call cards, which own their fetched content, so a
 * call's output is refetched on the next tap after a collapse. That is accepted:
 * level 2 is opt-in, the endpoint is cheap, and keeping collapsed bodies mounted
 * inside a virtualized row is the thing we are trying to avoid.
 */
import type { ToolCallContentItem } from '@simple-agent-manager/acp-client';
import {
  ThinkingBlock as AcpThinkingBlock,
  ToolCallCard as AcpToolCallCard,
} from '@simple-agent-manager/acp-client';
import { ChevronDown } from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';

import type { GroupedItem, ToolCallGroupItem } from './tool-call-groups';
import { summarizeToolCallGroup } from './tool-call-groups';

/** Motion state of the header glyph. Exposed as `data-state` so tests assert
 *  behaviour rather than colour, and so status is never colour-only. */
type GlyphState = 'running' | 'failed' | 'done';

interface AbsorbedConversationItemViewProps {
  item: GroupedItem;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
}

/**
 * Renders one absorbed item (a generic tool call or a thinking block) with the
 * project-chat presentation.
 *
 * Single implementation shared by `AcpConversationItemView` (for standalone
 * generic tool calls) and by this card's expanded body, so the two can never
 * drift apart (`.claude/rules/24`).
 */
export function AbsorbedConversationItemView({
  item,
  onFileClick,
  onLoadToolContent,
}: AbsorbedConversationItemViewProps) {
  if (item.kind === 'thinking') {
    return <AcpThinkingBlock text={item.text} active={item.active} />;
  }
  return (
    <AcpToolCallCard
      toolCall={item}
      onFileClick={onFileClick}
      onLoadContent={onLoadToolContent}
      className={
        item.contentLoaded === false ? 'glass-surface rounded-md border-border-default' : undefined
      }
    />
  );
}

function GroupGlyph({ state }: { state: GlyphState }) {
  if (state === 'running') {
    return (
      <span
        data-testid="tool-group-glyph"
        data-state="running"
        aria-hidden="true"
        className="block h-4 w-4 rounded-full border-2 border-t-transparent animate-spin motion-reduce:animate-none"
        style={{ borderColor: 'var(--sam-color-accent-primary)', borderTopColor: 'transparent' }}
      />
    );
  }
  if (state === 'failed') {
    return (
      <svg
        data-testid="tool-group-glyph"
        data-state="failed"
        aria-hidden="true"
        className="h-4 w-4"
        style={{ color: 'var(--sam-color-danger-fg)' }}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    );
  }
  return (
    <svg
      data-testid="tool-group-glyph"
      data-state="done"
      aria-hidden="true"
      className="h-4 w-4"
      style={{ color: 'var(--sam-color-success-fg)' }}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

export interface ToolCallGroupCardProps {
  group: ToolCallGroupItem;
  /**
   * `true` when this group is the last display row AND the agent is mid-turn.
   * Statuses flip per call, so between "call A completed" and "call B arrived"
   * every call in the tail group reads `completed`; without this the glyph would
   * flash check → spinner on every single call.
   */
  live?: boolean;
  /** Controlled expansion. Omit for uncontrolled (internal state) behaviour. */
  expanded?: boolean;
  /** Called with the group id when the header is activated (controlled mode). */
  onToggle?: (groupId: string) => void;
  onFileClick?: (path: string, line?: number | null) => void;
  onLoadToolContent?: (messageId: string) => Promise<ToolCallContentItem[]>;
}

function ToolCallGroupCardImpl({
  group,
  live = false,
  expanded,
  onToggle,
  onFileClick,
  onLoadToolContent,
}: ToolCallGroupCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  const controlled = expanded !== undefined;
  const isExpanded = controlled ? expanded : internalExpanded;

  const summary = useMemo(() => summarizeToolCallGroup(group), [group]);

  const handleToggle = useCallback(() => {
    if (controlled) {
      onToggle?.(group.id);
      return;
    }
    setInternalExpanded((prev) => !prev);
  }, [controlled, onToggle, group.id]);

  const thinking = summary.liveKind === 'thinking';
  const running = summary.runningCount > 0;
  const inMotion = running || thinking || live;
  const glyphState: GlyphState = inMotion ? 'running' : summary.failedCount > 0 ? 'failed' : 'done';

  const countLabel = `${summary.toolCallCount} ${summary.toolCallCount === 1 ? 'tool call' : 'tool calls'}`;

  /*
   * Screen-reader announcement for the run's lifecycle — deliberately NOT a
   * mirror of the visible header.
   *
   * The visible line changes on every token and every call (the running title is
   * the newest unfinished call), and a 40-call run would emit 40 announcements
   * over the top of whatever the user is reading. So this region carries only the
   * transitions that matter: the run starts, the run settles, and how many calls
   * failed. The text is CONSTANT for the whole of the in-motion phase, which is
   * what keeps it quiet. "The agent is busy" itself is already announced by the
   * completion dock's own status region, so this one is scoped to tool activity.
   */
  const statusAnnouncement = inMotion
    ? 'Tool activity in progress'
    : `${countLabel} completed${summary.failedCount > 0 ? `, ${summary.failedCount} failed` : ''}`;

  /*
   * Only cards that have actually been in motion during this mount carry the
   * region. Virtuoso mounts and unmounts rows as the user scrolls, and inserting
   * a populated live region is announced by some screen readers — so a settled
   * card scrolling into view would read out "7 tool calls completed" for history
   * the user never asked about. A card that was already settled when it mounted
   * has no transition to report, so it renders no region at all; one that
   * transitions running → settled keeps its region and announces the completion.
   */
  const wasInMotionRef = useRef(inMotion);
  if (inMotion) wasInMotionRef.current = true;
  // Status is carried by TEXT, never by colour alone.
  const liveText = thinking
    ? '· thinking…'
    : running && summary.liveTitle
      ? `· running ${summary.liveTitle}`
      : inMotion
        ? '· working'
        : null;

  return (
    <div className="flex justify-start my-2">
      {/*
        Collapsed, the card is capped at the agent bubble's 80% column so it
        reads as part of the conversation. Expanded, it takes the full message
        column: the nested `ToolCallCard` header packs a status glyph, a kind
        chip, a byte count and a chevron around its `truncate` title, and at
        375px the 80% cap left roughly 37px for the title ("Ba…"). The full
        column restores exactly the width a standalone tool card had before
        grouping. The width change only happens on an explicit tap, never while
        streaming.
      */}
      <div
        data-testid="tool-call-group"
        data-expanded={isExpanded ? 'true' : 'false'}
        className={`w-full min-w-0 glass-surface rounded-lg border border-border-default overflow-hidden${
          isExpanded ? '' : ' max-w-[80%]'
        }`}
      >
        {wasInMotionRef.current && (
          <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {statusAnnouncement}
          </span>
        )}
        <button
          type="button"
          aria-expanded={isExpanded}
          onClick={handleToggle}
          className="w-full min-w-0 flex items-center gap-2 px-3 py-2 text-left bg-transparent border-0 cursor-pointer hover:bg-surface-hover transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          <span className="shrink-0 flex items-center">
            <GroupGlyph state={glyphState} />
          </span>
          <span className="text-sm font-medium text-fg-primary shrink-0">{countLabel}</span>
          {liveText && (
            // Secondary, space-constrained detail: truncation is the design here
            // (rule 56 §4) — the full title is one tap away in the expanded list.
            <span className="text-xs text-fg-muted truncate min-w-0">{liveText}</span>
          )}
          {summary.failedCount > 0 && (
            <span className="text-xs text-danger-fg shrink-0">{`· ${summary.failedCount} failed`}</span>
          )}
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={`ml-auto shrink-0 text-fg-muted transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>

        {isExpanded && (
          <div className="border-t border-border-default px-2 py-1 min-w-0">
            {group.items.map((item) => (
              <AbsorbedConversationItemView
                key={item.id}
                item={item}
                onFileClick={onFileClick}
                onLoadToolContent={onLoadToolContent}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized for the same reason as `AcpConversationItemView`: a parent re-render
 * that changes nothing this row reads must not re-run the summary pass or
 * re-render the per-call cards. All props are primitives or stable callbacks at
 * the call site.
 */
export const ToolCallGroupCard = memo(ToolCallGroupCardImpl);
