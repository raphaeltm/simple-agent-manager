import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type { FC } from 'react';

import { DOCUMENT_CARD_TOOLS, normalizeToolName } from './document-card-data';
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
 * fall back. Dispatch is on the stable `toolName` discriminator, so unknown
 * tools always fall back with zero regression risk.
 */
export function matchToolCard(item: ToolCallItem): FC<ToolCardProps> | null {
  const base = normalizeToolName(item.toolName ?? item.title);
  if (base && DOCUMENT_CARD_TOOLS.has(base)) {
    return DocumentCard;
  }
  return null;
}
