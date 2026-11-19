// =============================================================================
// Admin → Infrastructure: SAM-capacity nodes stuck in teardown, and the superadmin
// attestation that removes one (idea 01M6DFJTV3VCFEJEBYMK3KYF7A, admin half)
// =============================================================================

/** Default and maximum page size for `GET /api/admin/nodes/stranded`. */
export const DEFAULT_ADMIN_STRANDED_NODES_LIMIT = 50;
export const MAX_ADMIN_STRANDED_NODES_LIMIT = 200;
/** Bound on the operator's note; matches the Operations approval note bound. */
export const OPERATOR_NODE_DELETION_NOTE_MAX_CHARS = 1_000;

/** A SAM-capacity managed VM node in `destroying`. */
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
  /** When SAM first recorded that it cannot finish this node's teardown; null if not yet. */
  cleanupBlockedSince: string | null;
  /** Why, e.g. `teardown_credential_generation_changed`. */
  cleanupBlockedReason: string | null;
  /** Last teardown error text, truncated. */
  errorMessage: string | null;
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
