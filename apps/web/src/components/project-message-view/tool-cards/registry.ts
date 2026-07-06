import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type { FC } from 'react';

import { DOCUMENT_CARD_TOOLS, extractDocumentCardData, normalizeToolName } from './document-card-data';
import { DocumentCard } from './DocumentCard';

/** Props every typed tool-call card receives. */
export interface ToolCardProps {
  item: ToolCallItem;
  /** Project the card belongs to — needed for library preview URLs. */
  projectId?: string;
}

/**
 * Typed tool-call card registry. Given a tool-call item, returns a specialized
 * card component to render in place of the generic ToolCallCard, or null to
 * fall back.
 *
 * Two-layer, agent-agnostic dispatch:
 *  1. Name hint — normalize the identifier (delimiter-agnostic) and check the
 *     known typed-card tool set. Unknown tools fall back with zero risk.
 *  2. Shape authority — validate the payload actually yields a renderable
 *     document. A name match with a malformed/absent payload (`unavailable`)
 *     falls back to the generic card rather than showing a broken empty card.
 *     This makes recognition resilient to new agents (any separator works) AND
 *     to bad data (the failure mode is always the generic card).
 */
export function matchToolCard(item: ToolCallItem): FC<ToolCardProps> | null {
  const base = normalizeToolName(item.toolName ?? item.title);
  if (!base || !DOCUMENT_CARD_TOOLS.has(base)) {
    return null;
  }
  // Name says "library tool"; the payload is the authority on whether we can
  // render a document. ready/pending/tombstone render; unavailable falls back.
  if (extractDocumentCardData(item).state === 'unavailable') {
    return null;
  }
  return DocumentCard;
}
