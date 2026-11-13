import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import type { FC } from 'react';

import { extractApprovalId, isApprovalCardTool } from './approval-card-data';
import { ApprovalCard } from './ApprovalCard';
import {
  DOCUMENT_CARD_TOOLS,
  extractDocumentCardData,
  normalizeToolName,
} from './document-card-data';
import { DocumentCard } from './DocumentCard';
import { extractHumanInputRequest, isHumanInputCardTool } from './human-input-card-data';
import { HumanInputCard } from './HumanInputCard';
import { extractSecretRequestId, isSecretRequestCardTool } from './secret-request-card-data';
import { SecretRequestCard } from './SecretRequestCard';
import { isTypedCardToolName } from './typed-card-tools';

/** Props every typed tool-call card receives. */
export interface ToolCardProps {
  item: ToolCallItem;
  /** Project the card belongs to — needed for library preview URLs and approval scoping. */
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
/**
 * Per-item-object memo.
 *
 * `matchToolCard` is now on two hot paths for the SAME item object on every
 * streamed token: `groupToolCallItems`' absorbability check and
 * `AcpConversationItemView`'s `tool_call` case. For a library tool the payload
 * branch `JSON.parse`s `rawOutput`, so the unmemoized version paid that twice
 * per item per token.
 *
 * A `WeakMap` is the right cache here precisely BECAUSE
 * `chatMessagesToConversationItems` rebuilds every item object on every call:
 * each render pass gets fresh keys, the previous pass's entries become
 * unreachable and are collected, and a mutated item can never be served a stale
 * verdict. Do not replace it with a keyed cache on `toolCallId` — statuses and
 * payloads change in place, and that cache would go stale.
 */
const matchCache = new WeakMap<ToolCallItem, FC<ToolCardProps> | null>();

export function matchToolCard(item: ToolCallItem): FC<ToolCardProps> | null {
  const cached = matchCache.get(item);
  if (cached !== undefined) return cached;
  const matched = resolveToolCard(item);
  matchCache.set(item, matched);
  return matched;
}

function resolveToolCard(item: ToolCallItem): FC<ToolCardProps> | null {
  // One list of card tools for the registry and the message converter (TYPED_CARD_TOOLS): a card
  // missing from it never renders, rather than rendering only for harnesses that repeat the tool
  // name on every row.
  if (!isTypedCardToolName(item.toolName ?? item.title)) {
    return null;
  }
  // Operations approval request: the card needs the approval ID from the result. While the
  // call runs, or when it failed, the generic card shows it (and any error) instead.
  if (isApprovalCardTool(item)) {
    return item.status !== 'failed' && extractApprovalId(item) ? ApprovalCard : null;
  }
  // Agent question: the card needs the attention marker reference from the result. While the
  // call runs, when it failed, or for results recorded before the structured payload, the
  // generic card shows it instead.
  if (isHumanInputCardTool(item)) {
    return item.status !== 'failed' && extractHumanInputRequest(item) ? HumanInputCard : null;
  }
  // Agent secret request: the card needs the request ID from the result. While the call runs, or
  // when it failed (bad name, override, cap), the generic card shows it and the error instead.
  if (isSecretRequestCardTool(item)) {
    return item.status !== 'failed' && extractSecretRequestId(item) ? SecretRequestCard : null;
  }
  if (!DOCUMENT_CARD_TOOLS.has(normalizeToolName(item.toolName ?? item.title) ?? '')) {
    return null;
  }
  // Name says "library tool"; the payload is the authority on whether we can
  // render a document. ready/pending/tombstone render; unavailable falls back.
  if (extractDocumentCardData(item).state === 'unavailable') {
    return null;
  }
  return DocumentCard;
}
