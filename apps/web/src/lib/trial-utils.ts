/**
 * Pure utility functions for the trial discovery UI.
 *
 * Extracted from TryDiscovery.tsx — no React dependencies.
 */
import type { TrialEvent } from '@simple-agent-manager/shared';

/**
 * Clean up raw agent activity text for display. Strips XML tags, collapses
 * JSON blobs, and trims whitespace so the feed stays readable.
 */
export function cleanActivityText(text: string): string {
  // Strip XML-style tags (e.g. <path>...</path>, <content>...</content>)
  let cleaned = text.replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  // Collapse whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  // If it looks like a JSON blob, summarize it
  if (cleaned.startsWith('{') && cleaned.length > 80) {
    try {
      const obj = JSON.parse(text.length <= 200 ? text : text + '"}');
      // Try to extract a meaningful summary
      const repo = obj.repository as string | undefined;
      const status = obj.status as string | undefined;
      if (repo && status) return `Workspace: ${repo} (${status})`;
    } catch {
      // Not valid JSON — just truncate
    }
    return cleaned.slice(0, 80) + '…';
  }
  return cleaned;
}

export function extractRepoName(repoUrl: string): string {
  const match = /github\.com\/([^/]+\/[^/?#.]+)/i.exec(repoUrl);
  return match?.[1] ?? repoUrl;
}

/**
 * Build a stable dedup key for any TrialEvent. Most events carry an `at`
 * timestamp; `trial.started` carries `startedAt` instead. Combining the
 * timestamp with the event type makes the key collision-resistant across
 * the discriminated union.
 */
export function eventDedupKey(event: TrialEvent): string {
  const ts = event.type === 'trial.started' ? event.startedAt : event.at;
  return `${event.type}:${ts}`;
}
