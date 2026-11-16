/**
 * Words for the Run receipt (`RunReceiptView`). The server sends measurements only; every label
 * the person reads is chosen here, so the Connector and sam-mcp surfaces stay free to phrase
 * the same numbers their own way.
 */
import type {
  RunReceipt,
  RunReceiptAccount,
  RunReceiptPhaseKey,
  RunReceiptSection,
  RunReceiptSlowItem,
  RunReceiptToolKindCount,
} from '@simple-agent-manager/shared';

import { formatBytes, formatElapsed } from '../resource-timeline/format';

export const PHASE_LABEL: Record<RunReceiptPhaseKey, string> = {
  machine: 'Waiting for a machine',
  setup: 'Setup',
  agent: 'Agent working',
  waiting: 'Waiting on a person',
  ci: 'CI',
};

/**
 * One colour per phase. Amber is reserved for "waiting on you" and green for "working"
 * (`apps/web/.claude/rules/80-sam-glass.md`), so those two phases take them; the others use
 * the categorical chart series.
 */
export const PHASE_COLOR: Record<RunReceiptPhaseKey, string> = {
  machine: 'var(--sam-color-info)',
  setup: 'var(--sam-admin-chart-series-9)',
  agent: 'var(--sam-color-success)',
  waiting: 'var(--sam-color-warning)',
  ci: 'var(--sam-color-purple)',
};

const TOOL_KIND_LABEL: Record<string, string> = {
  execute: 'shell',
  read: 'read',
  edit: 'edit',
  search: 'search',
  fetch: 'fetch',
  think: 'think',
  delete: 'delete',
  move: 'move',
  switch_mode: 'mode',
  other: 'other',
};

export function toolKindLabel(kind: string): string {
  return TOOL_KIND_LABEL[kind] ?? kind;
}

/** A missing duration on a live run has not happened yet; on a finished run it was not recorded. */
export function formatDuration(ms: number | null, live = false): string {
  if (ms !== null) return formatElapsed(ms);
  return live ? 'not yet' : 'not recorded';
}

const SECTION_LABEL: Record<RunReceiptSection, string> = {
  outcome: 'the pull request',
  toolCalls: 'tool calls',
  comparison: 'the comparison with recent runs',
  account: 'the account',
};

/** "tool calls and the account", for the parts of the receipt that could not be read. */
export function unavailableSummary(sections: RunReceiptSection[]): string {
  const labels = sections.map((section) => SECTION_LABEL[section]);
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** "74 shell · 61 read · 39 edit", the three largest kinds. */
export function toolKindSummary(byKind: RunReceiptToolKindCount[]): string {
  return byKind
    .slice(0, 3)
    .map((entry) => `${entry.count} ${toolKindLabel(entry.kind)}`)
    .join(' · ');
}

/** The chip at the top: what the run produced, or where it ended. */
export function outcomeLabel(receipt: RunReceipt): {
  label: string;
  tone: 'success' | 'info' | 'danger' | 'neutral';
} {
  const pr = receipt.outcome.pullRequest;
  if (pr?.state === 'merged') return { label: 'Merged', tone: 'success' };
  if (pr?.state === 'open') return { label: 'PR open', tone: 'info' };
  if (pr?.state === 'closed') return { label: 'PR closed', tone: 'neutral' };
  if (receipt.live) return { label: 'Running', tone: 'info' };
  if (receipt.status === 'failed') return { label: 'Failed', tone: 'danger' };
  if (receipt.status === 'cancelled') return { label: 'Cancelled', tone: 'neutral' };
  return { label: 'Finished', tone: 'success' };
}

const CHECKS_LABEL: Record<NonNullable<RunReceipt['outcome']['checks']>, string> = {
  success: 'CI passed',
  failure: 'CI failing',
  pending: 'CI running',
  neutral: 'CI neutral',
};

/** "PR #2771 · CI passed · 42m" under the chip. */
export function outcomeLine(receipt: RunReceipt): string {
  const parts: string[] = [];
  const pr = receipt.outcome.pullRequest;
  if (pr) parts.push(`PR #${pr.number}`);
  if (receipt.outcome.checks) parts.push(CHECKS_LABEL[receipt.outcome.checks]);
  parts.push(
    receipt.live ? `${formatElapsed(receipt.totalMs)} so far` : formatElapsed(receipt.totalMs)
  );
  return parts.join(' · ');
}

const SOURCE_LABEL: Record<string, string> = {
  user: 'Personal account',
  project: 'Project account',
  platform: 'SAM platform account',
};

const SCOPE_LABEL: Record<string, string> = {
  run: 'chosen for this run',
  profile: 'pinned by the profile',
  project: 'project default',
  user: 'your default',
  platform: 'platform default',
};

/** The account tile: its name for the person who ran it, its kind for everyone else. */
export function accountTile(account: RunReceiptAccount | null): { value: string; note: string } {
  if (!account) return { value: 'Not recorded', note: 'No agent session recorded an account' };
  const kind = (account.credentialSource && SOURCE_LABEL[account.credentialSource]) ?? 'Account';
  const scope = account.credentialScope ? SCOPE_LABEL[account.credentialScope] : null;
  const note = [account.accountName ? kind : null, scope, account.agentType]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return { value: account.accountName ?? kind, note: note || 'Kind of account only' };
}

function usualDetail(item: RunReceiptSlowItem): string | null {
  if (item.usualMs === null || item.durationMs === null || item.usualMs <= 0) return null;
  const ratio = item.durationMs / item.usualMs;
  const subject = item.comparedBy === 'profile' ? 'this profile’s' : 'this skill’s';
  const runs = item.sampleSize ? ` (${item.sampleSize} runs)` : '';
  return `${ratio.toFixed(1)}× ${subject} usual ${formatElapsed(item.usualMs)}${runs}`;
}

/** Title and detail line for one "What slowed it down" item. */
export function slowItemText(item: RunReceiptSlowItem): { title: string; detail: string | null } {
  switch (item.kind) {
    case 'machine':
      return {
        title: `Waited ${formatDuration(item.durationMs)} for a machine`,
        detail: usualDetail(item),
      };
    case 'setup':
      return { title: `Setup took ${formatDuration(item.durationMs)}`, detail: usualDetail(item) };
    case 'waiting':
      return {
        title: `Waited ${formatDuration(item.durationMs)} on a person`,
        detail: item.question ? `“${item.question}”` : null,
      };
    case 'ci_failing':
      return {
        title: 'CI is failing on the latest commit',
        detail: item.durationMs ? `${formatElapsed(item.durationMs)} waiting on checks` : null,
      };
    case 'oom':
      return {
        title: `Ran out of memory ${item.count ?? 1}×`,
        detail: 'The workspace hit its memory limit and a process was killed',
      };
    case 'memory':
      return {
        title: `Memory peaked at ${formatBytes(item.peakMemoryBytes)}`,
        detail:
          item.requestedMemoryMb !== null
            ? `of ${formatBytes(item.requestedMemoryMb * 1024 * 1024)} requested`
            : null,
      };
  }
}
