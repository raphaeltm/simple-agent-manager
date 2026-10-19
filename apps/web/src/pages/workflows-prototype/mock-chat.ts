/**
 * PROTOTYPE ONLY — synthetic transcripts in the real ChatMessageResponse shape,
 * so the real chatMessagesToConversationItems / AcpConversationItemView path
 * renders them exactly like production chat.
 */
import type { ChatMessageResponse } from '../../lib/api';
import { minutesAgo } from './mock-world';

let seq = 0;
function msg(
  sessionId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
  ago: number,
  extra: Partial<ChatMessageResponse> = {}
): ChatMessageResponse {
  seq += 1;
  return {
    id: `${sessionId}-m${seq}`,
    sessionId,
    role,
    content,
    toolMetadata: null,
    createdAt: minutesAgo(ago),
    sequence: seq,
    ...extra,
  };
}

function tool(sessionId: string, title: string, toolName: string, ago: number) {
  return msg(sessionId, 'tool', '', ago, {
    toolMetadata: {
      toolCallId: `${sessionId}-${toolName}-${ago}`,
      kind: 'other',
      title,
      toolName,
      status: 'completed',
    },
  });
}

const R = 's-flags-chat';

export const RESEARCH_OPENING: ChatMessageResponse[] = [
  msg(
    R,
    'user',
    'We need a feature-flag service for Payments API. Compare LaunchDarkly, Unleash, GrowthBook and Flagsmith on price at 25 seats, self-hosting, Go and TypeScript SDKs, and audit logging. Recommend one and write it up.',
    44
  ),
  msg(
    R,
    'assistant',
    'Good scope for a short research run: the four evaluations can happen in parallel. I’ll set it up as a **one-off run** and start it now — you can follow it here or on the run page.',
    43
  ),
  tool(R, 'get_project_knowledge: preferences', 'mcp__sam-mcp__get_project_knowledge', 43),
  tool(R, 'list_agent_profiles', 'mcp__sam-mcp__list_agent_profiles', 43),
];

export const RESEARCH_AFTER_START: ChatMessageResponse[] = [
  msg(
    R,
    'assistant',
    'Started. The evaluations run two at a time so they don’t take over every machine. I’ll go to sleep now — SAM wakes me when the run finishes or needs a decision.',
    42
  ),
];

export const RESEARCH_NEEDS_ATTENTION: ChatMessageResponse[] = [
  msg(
    R,
    'user',
    '[SAM] Run “Research: choosing a feature-flag service” needs attention: step “Evaluate GrowthBook” failed (agent reported it could not verify sources).',
    7,
    { origin: 'system' }
  ),
  msg(
    R,
    'assistant',
    'One evaluation failed: GrowthBook’s docs site blocked automated access. I can **retry it** using their GitHub README and public pricing PDF, or **skip it** and compare the other three. Which do you prefer? The other evaluations keep going meanwhile.',
    6
  ),
];

export const RESEARCH_RETRIED: ChatMessageResponse[] = [
  msg(R, 'user', 'Retry it with the README and the pricing PDF.', 5),
  msg(
    R,
    'assistant',
    'Retrying “Evaluate GrowthBook” with those sources (attempt 2). Going back to sleep.',
    5
  ),
];

export const RESEARCH_SKIPPED: ChatMessageResponse[] = [
  msg(R, 'user', 'Skip it — compare the other three.', 5),
  msg(
    R,
    'assistant',
    'Skipped GrowthBook. The report will compare LaunchDarkly, Unleash and Flagsmith.',
    5
  ),
];

export const RESEARCH_DONE: ChatMessageResponse[] = [
  msg(
    R,
    'user',
    '[SAM] Run “Research: choosing a feature-flag service” finished: 6 of 6 steps done. Report saved to Library.',
    1,
    { origin: 'system' }
  ),
  msg(
    R,
    'assistant',
    '**Recommendation: GrowthBook, self-hosted.** It meets 4 of 5 criteria at the lowest cost: MIT licence, audit log included when self-hosted, strong TypeScript SDK (the Go SDK is community-maintained). If we’d rather not run it ourselves, LaunchDarkly is the safe paid choice at about $12k a year.\n\nFull write-up: `feature-flag-comparison.md` in the Library.\n\nWe compare tools fairly often — want me to save this as a reusable **“Technology comparison”** workflow?',
    1
  ),
];

const S = 's-csv-impl';
export const STEP_CHAT: ChatMessageResponse[] = [
  msg(
    S,
    'user',
    '[SAM workflow step 2 of 7: “Implement the change” in run “Fix: CSV export drops the last row”]\n\nRun goal: CSV export drops the last row when the file ends without a trailing newline.\n\nResults from earlier steps (agent-written, check before relying on them):\n- Plan the change (done): exportCsv() drops the final row when the file has no trailing newline (exporter.ts:88). Plan: fix the slice, add a regression test, check the statement export too.\n\nYour step: Make the change on a new branch with a regression test, then open a pull request. This step counts as done only when a PR exists.',
    62,
    { origin: 'system' }
  ),
  msg(
    S,
    'assistant',
    'Starting from the plan: the off-by-one is in `exportCsv()` at exporter.ts:88. I’ll fix the slice, add a regression test for files without a trailing newline, then open the PR.',
    61
  ),
  tool(S, 'Read src/export/exporter.ts', 'Read', 61),
  tool(S, 'Edit src/export/exporter.ts', 'Edit', 58),
  tool(S, 'Write test/export/exports-last-row.test.ts', 'Write', 55),
  tool(S, 'Bash: pnpm vitest run test/export', 'Bash', 52),
  tool(S, 'Bash: gh pr create --title "Fix CSV export dropping the last row"', 'Bash', 48),
  msg(
    S,
    'assistant',
    'Done. Fixed the slice and added `exports-last-row.test.ts` (386 unit tests pass). Opened **PR #482 — Fix CSV export dropping the last row** on `fix/csv-last-row`. Next in the run: review and staging tests start automatically.',
    46
  ),
];
