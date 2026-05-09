/**
 * Candidate diff — computes and displays differences between two harness candidates.
 *
 * Used by the proposer to understand what changed between versions and
 * correlate configuration changes with eval result deltas.
 */

import type { HarnessCandidate } from './candidate.js';

/** A single field-level change between two candidates. */
export interface CandidateChange {
  field: string;
  before: string;
  after: string;
}

/** Full diff between two candidates. */
export interface CandidateDiff {
  fromVersion: string;
  toVersion: string;
  changes: CandidateChange[];
  systemPromptChanged: boolean;
  /** Line-level diff of system prompt if changed */
  systemPromptDiff?: string;
}

/** Compute a structured diff between two candidates. */
export function diffCandidates(a: HarnessCandidate, b: HarnessCandidate): CandidateDiff {
  const changes: CandidateChange[] = [];

  if (a.modelId !== b.modelId) {
    changes.push({ field: 'modelId', before: a.modelId, after: b.modelId });
  }
  if (a.temperature !== b.temperature) {
    changes.push({ field: 'temperature', before: String(a.temperature), after: String(b.temperature) });
  }
  if (a.maxTurns !== b.maxTurns) {
    changes.push({ field: 'maxTurns', before: String(a.maxTurns), after: String(b.maxTurns) });
  }
  if (a.toolProfile.name !== b.toolProfile.name) {
    changes.push({ field: 'toolProfile.name', before: a.toolProfile.name, after: b.toolProfile.name });
  }

  const toolsA = a.toolProfile.tools.sort().join(', ');
  const toolsB = b.toolProfile.tools.sort().join(', ');
  if (toolsA !== toolsB) {
    changes.push({ field: 'toolProfile.tools', before: toolsA, after: toolsB });
  }

  const systemPromptChanged = a.systemPrompt !== b.systemPrompt;
  if (systemPromptChanged) {
    changes.push({
      field: 'systemPrompt',
      before: `(${a.systemPrompt.length} chars)`,
      after: `(${b.systemPrompt.length} chars)`,
    });
  }

  return {
    fromVersion: a.versionId,
    toVersion: b.versionId,
    changes,
    systemPromptChanged,
    systemPromptDiff: systemPromptChanged ? computeLineDiff(a.systemPrompt, b.systemPrompt) : undefined,
  };
}

/** Format a diff for display (console or proposer input). */
export function formatDiff(diff: CandidateDiff): string {
  const lines: string[] = [];
  lines.push(`Diff: ${diff.fromVersion} -> ${diff.toVersion}`);
  lines.push('='.repeat(50));

  if (diff.changes.length === 0) {
    lines.push('No changes detected.');
    return lines.join('\n');
  }

  for (const c of diff.changes) {
    if (c.field === 'systemPrompt') {
      lines.push(`[systemPrompt] changed (${c.before} -> ${c.after})`);
    } else {
      lines.push(`[${c.field}] ${c.before} -> ${c.after}`);
    }
  }

  if (diff.systemPromptDiff) {
    lines.push('');
    lines.push('--- System Prompt Diff ---');
    lines.push(diff.systemPromptDiff);
  }

  return lines.join('\n');
}

/** Simple line-level diff (added/removed lines). */
function computeLineDiff(before: string, after: string): string {
  const linesA = before.split('\n');
  const linesB = after.split('\n');
  const output: string[] = [];

  const maxLen = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < maxLen; i++) {
    const a = linesA[i];
    const b = linesB[i];
    if (a === undefined && b !== undefined) {
      output.push(`+ ${b}`);
    } else if (b === undefined && a !== undefined) {
      output.push(`- ${a}`);
    } else if (a !== b) {
      output.push(`- ${a}`);
      output.push(`+ ${b}`);
    }
  }

  return output.join('\n');
}
