/**
 * Shared linked-work presentation, used by the chat's Related panel, the library file preview
 * and the idea page. It lives here rather than under any one of those so none of them owns it,
 * and so there is exactly one row shape, one pull-request badge and one map from a relation to
 * plain words (coordinator decision on `feature.linked-work`, `.claude/rules/24`).
 */
export { LinkedWorkRow, type LinkedWorkRowProps } from './LinkedWorkRow';
export { PullRequestStateBadge } from './PullRequestStateBadge';
export {
  describeRelations,
  fileProvenance,
  formatCappedTotal,
  LINK_RELATION_LABELS,
  linkedSessionLabel,
  orderFileSessions,
  sortLinkRelations,
} from './relation-labels';
