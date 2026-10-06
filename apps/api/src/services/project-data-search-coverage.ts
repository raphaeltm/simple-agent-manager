import type { MessageSearchCoverage } from '../durable-objects/project-data/message-search';

/**
 * What the root object's bounded search windows skipped (`message-search.ts`). `null` when the root
 * was not queried because the session lives on an archive shard.
 */
export type ProjectDataRootSearchCoverage = MessageSearchCoverage;

/**
 * Plain-language disclosure of a truncated root search, for consumers (agents) that cannot notice
 * results they were never shown. Empty when nothing was skipped.
 */
export function describeRootSearchCoverage(
  coverage: ProjectDataRootSearchCoverage | null
): string[] {
  if (!coverage) return [];
  const notes: string[] = [];
  if (coverage.ftsCandidatesTruncated) {
    notes.push(
      `Full-text ranking considered only the newest ${coverage.ftsCandidateLimit} matching messages; older matches exist but were not ranked. Add more specific words or narrow with sessionId to reach them.`
    );
  }
  if (coverage.keywordScanTruncated) {
    notes.push(
      `The keyword fallback for not-yet-indexed text scanned only the newest ${coverage.keywordScanRowLimit} raw messages; older unindexed text was not searched.`
    );
  }
  return notes;
}
