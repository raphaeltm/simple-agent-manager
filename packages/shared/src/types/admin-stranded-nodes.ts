// =============================================================================
// Admin → Infrastructure: SAM-capacity nodes stuck in teardown, and the superadmin
// attestation that removes one (idea 01M6DFJTV3VCFEJEBYMK3KYF7A, admin half)
// =============================================================================

/** Default and maximum page size for `GET /api/admin/nodes/stranded`. */
export const DEFAULT_ADMIN_STRANDED_NODES_LIMIT = 50;
export const MAX_ADMIN_STRANDED_NODES_LIMIT = 200;
/** Bound on the operator's note; matches the Operations approval note bound. */
export const OPERATOR_NODE_DELETION_NOTE_MAX_CHARS = 1_000;

/**
 * Recorded teardown refusals (first token of `nodes.cleanup_blocked_reason`) for which a
 * superadmin may attest that the node's server is gone. Each one means SAM cannot see or prove
 * anything about the server, so a person checking the provider console is the only evidence left.
 * Refusals that mean a server may well be live (`teardown_instance_ownership_mismatch`,
 * `teardown_delete_refused`, `teardown_deletion_unconfirmed`) are deliberately absent: the
 * operator must resolve those at the provider first. An allowlist, so a new refusal is excluded
 * until someone decides it belongs (rule 79).
 */
export const OPERATOR_REMOVABLE_BLOCK_REASONS = [
  /** The pinned credential was re-saved or rotated after placement (providerless node). */
  'teardown_credential_generation_changed',
  /** The create failed before a server ID; the exact credential's inventory is empty. */
  'teardown_allocation_unresolved',
  /** The pinned credential was removed or disabled, and no current credential resolves. */
  'teardown_credential_unavailable',
  /** No current credential can see the recorded server ID. */
  'teardown_instance_not_visible',
  /** The node predates the placement snapshot strict teardown needs (cleanup refusal). */
  'provenance',
] as const;

/** First token of a recorded `cleanup_blocked_reason` (a comma-separated list), or null. */
export function primaryCleanupBlockReason(reason: string | null | undefined): string | null {
  const first = reason?.split(',')[0]?.trim();
  return first ? first : null;
}

export function isOperatorRemovableBlockReason(reason: string | null | undefined): boolean {
  const first = primaryCleanupBlockReason(reason);
  return first !== null && (OPERATOR_REMOVABLE_BLOCK_REASONS as readonly string[]).includes(first);
}

/** A SAM-capacity managed VM node in `destroying` with a recorded teardown failure. */
export interface AdminStrandedNode {
  id: string;
  ownerUserId: string;
  ownerEmail: string | null;
  nodeRole: string;
  cloudProvider: string | null;
  /** Null when the node's create failed before the provider returned a server ID. */
  providerInstanceId: string | null;
  vmLocation: string | null;
  createdAt: string;
  lastHeartbeatAt: string | null;
  /** When SAM first recorded that it cannot finish this node's teardown. */
  cleanupBlockedSince: string;
  /** Why, e.g. `teardown_credential_generation_changed`. */
  cleanupBlockedReason: string | null;
  /** Last teardown error text, truncated. */
  errorMessage: string | null;
  /** Whether the recorded refusal is one a superadmin may attest past (`isOperatorRemovableBlockReason`). */
  operatorRemovable: boolean;
}

export interface ListAdminStrandedNodesResponse {
  nodes: AdminStrandedNode[];
  /** Every matching node, including any beyond this page. */
  total: number;
}

export interface OperatorNodeDeletionRequest {
  /** The node ID, typed by the operator. */
  confirmation: string;
  /** What the operator checked at the provider. Stored in the audit log with who and when. */
  note: string;
}
