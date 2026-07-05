import type { ConversationItem } from '@simple-agent-manager/acp-client';

/**
 * Deterministic stress dataset for the virtualization benchmark.
 *
 * Models the exact case Raphaël described: a long conversation dominated by
 * COLLAPSED tool-call cards (consistent height) interspersed with variable-
 * height agent markdown responses. The mix of fixed-height cards and highly
 * variable text is what stresses an estimate-then-correct virtualizer and
 * produces the "jumping" while scrolling.
 *
 * Seeded PRNG so both virtualizers render byte-identical content and the
 * comparison is apples-to-apples across runs.
 */

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOL_NAMES = ['Read', 'Bash', 'Grep', 'Edit', 'Glob', 'Write', 'TodoWrite'];
const TOOL_TITLES: Record<string, string[]> = {
  Read: ['Read src/index.ts', 'Read apps/api/routes/tasks.ts', 'Read package.json'],
  Bash: ['pnpm test', 'git status --short', 'pnpm --filter web build'],
  Grep: ['Grep "useVirtualizer"', 'Grep "ConversationItem"', 'Grep "TODO"'],
  Edit: ['Edit index.tsx', 'Edit AcpConversationItemView.tsx', 'Edit types.ts'],
  Glob: ['Glob "**/*.tsx"', 'Glob "apps/**/*.ts"'],
  Write: ['Write mock-data.ts', 'Write VirtuosoBench.tsx'],
  TodoWrite: ['Update todo list'],
};

// Agent markdown snippets spanning a wide height range: one-liners up to long
// multi-paragraph answers with code fences, lists, and headings. This is the
// real source of height variance (react-markdown) in production.
const SHORT_AGENT = [
  'Done.',
  'That change is applied.',
  'Looks good — tests pass.',
  'I found the issue.',
  'Let me check the other file.',
];

const MED_AGENT = [
  "I've updated the component to use the new hook. The key change is that we now\nresolve the session id from the canonical mapping instead of the workspace-\nscoped heuristic, which avoids attaching the wrong live session.",
  "There are two problems here:\n\n1. The virtualizer estimates item heights and corrects on measure.\n2. The tool cards and text responses have very different heights.\n\nTogether these produce the scroll jump you're seeing.",
  "The route is mounted before `projectsRoutes` so the callback JWT auth applies.\nI verified this by tracing the mount order in `index.ts` and confirming the\nmiddleware does not run `getUserId` on this path.",
];

const LONG_AGENT = [
  `Here's what I found after tracing the full data path:

## Root cause

The \`followOutput\` callback re-anchors to the bottom on every append, and
because item heights are measured lazily, Virtuoso applies a scroll correction
each time a newly measured row differs from its estimate. When the conversation
mixes fixed-height tool cards with variable-height agent text, the running
estimate is frequently wrong, so corrections fire constantly.

## Options considered

- Provide a more accurate \`estimateSize\` — helps but does not eliminate it.
- Freeze tool-card heights — already fixed, not the dominant factor.
- Switch to a virtualizer that skips correction during backward scroll.

\`\`\`ts
const rowVirtualizer = useVirtualizer({
  count: items.length,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => 120,
  overscan: 12,
  getItemKey: (i) => items[i].id,
  anchorTo: 'end',
});
\`\`\`

## Recommendation

Adopt end-anchored virtualization and keep the fixed-height cards. This removes
the upward-scroll jump entirely while preserving the bottom-follow behavior.`,
  `I ran the benchmark across both libraries with a 1,500-item stress dataset.

The measured involuntary content displacement during upward scrolling was
substantially lower with the end-anchored virtualizer. This matches the
theory: the default \`shouldAdjustScrollPositionOnItemSizeChange\` behavior
skips scroll correction while the user scrolls backward (up), which is exactly
when the jump was most visible.

A few caveats worth calling out before we commit to a migration:

- The production component also drives \`firstItemIndex\` for the "load earlier"
  prepend. We need an equivalent anchor-preserving prepend in the new library.
- The timeline jump-to-message uses \`scrollToIndex\` with a data-array index;
  the new adapter exposes \`scrollToIndex\` too but the coordinate space differs.
- Follow-on-append needs wiring so new agent output still sticks to the bottom.

None of these are blockers, but they are real integration work beyond a
drop-in swap.`,
];

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

export function generateConversation(count: number, seed = 1337): ConversationItem[] {
  const rng = mulberry32(seed);
  const items: ConversationItem[] = [];
  let ts = Date.now() - count * 60_000;

  for (let i = 0; i < count; i++) {
    ts += 1000 + Math.floor(rng() * 5000);
    const roll = rng();

    if (roll < 0.62) {
      // Collapsed tool-call card — consistent height, dominant item type.
      const toolName = pick(rng, TOOL_NAMES);
      const title = pick(rng, TOOL_TITLES[toolName] ?? [toolName]);
      items.push({
        kind: 'tool_call',
        id: `tool-${i}`,
        toolCallId: `tc-${i}`,
        title,
        toolName,
        toolKind: 'other',
        status: 'completed',
        content: [],
        locations: [],
        contentLoaded: true,
        timestamp: ts,
      });
    } else if (roll < 0.92) {
      // Variable-height agent markdown response.
      const bucket = rng();
      const text =
        bucket < 0.45 ? pick(rng, SHORT_AGENT) : bucket < 0.8 ? pick(rng, MED_AGENT) : pick(rng, LONG_AGENT);
      items.push({
        kind: 'agent_message',
        id: `agent-${i}`,
        text,
        streaming: false,
        timestamp: ts,
      });
    } else if (roll < 0.97) {
      // Occasional user message.
      items.push({
        kind: 'user_message',
        id: `user-${i}`,
        text: pick(rng, [
          'Can you check the tests?',
          'What about the scroll jumping?',
          'Try the tanstack one.',
          'Push that to a branch.',
        ]),
        timestamp: ts,
      });
    } else {
      // Occasional thinking block.
      items.push({
        kind: 'thinking',
        id: `think-${i}`,
        text: pick(rng, [
          'Let me trace the data path before proposing a change.',
          'The estimate is probably wrong for the tool cards; checking measurement.',
        ]),
        active: false,
        timestamp: ts,
      });
    }
  }

  return items;
}
