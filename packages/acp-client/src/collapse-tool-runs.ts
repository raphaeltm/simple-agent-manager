import type { ConversationItem, ToolCallGroupItem, ToolCallItem } from './hooks/useAcpMessages';

export type CollapseToolRunsOptions = {
  /**
   * Minimum run length worth collapsing. A lone tool call already reads as one
   * line, so wrapping it in a "1 tool call" card adds a tap for no gain.
   */
  minRunLength?: number;
  /**
   * Calls the host renders with a typed card (document previews, media, …).
   * Those are shown deliberately, so they break the run and render standalone
   * rather than being hidden behind a count.
   */
  isStandalone?: (call: ToolCallItem) => boolean;
};

export const DEFAULT_MIN_COLLAPSED_TOOL_RUN = 2;

/**
 * Collapse runs of consecutive tool calls into `tool_call_group` items.
 *
 * Pure and order-preserving: every input item appears exactly once, either on
 * its own or inside one group, so nothing can be dropped by the transform.
 */
export function collapseToolRuns(
  items: ConversationItem[],
  options: CollapseToolRunsOptions = {}
): ConversationItem[] {
  const minRunLength = options.minRunLength ?? DEFAULT_MIN_COLLAPSED_TOOL_RUN;
  const isStandalone = options.isStandalone;

  const result: ConversationItem[] = [];
  let run: ToolCallItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length < minRunLength) {
      result.push(...run);
    } else {
      const first = run[0] as ToolCallItem;
      const group: ToolCallGroupItem = {
        kind: 'tool_call_group',
        id: first.id,
        calls: run,
        timestamp: first.timestamp,
      };
      result.push(group);
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'tool_call' && !(isStandalone?.(item) ?? false)) {
      run.push(item);
      continue;
    }
    flush();
    result.push(item);
  }
  flush();

  return result;
}
